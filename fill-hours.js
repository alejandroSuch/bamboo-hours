require('dotenv').config();

const { chromium } = require('playwright');

const NOTE = process.argv[3] || '';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const NAV_TIMEOUT = 60000;

// BambooHR holds long-lived connections open, so 'networkidle' never fires.
function open(page, url) {
  return page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT
  });
}

// Parse a YYYY-MM-DD string as a UTC date to avoid timezone drift.
function parseDate(str) {
  if (!DATE_RE.test(str)) {
    throw new Error(`Invalid date: "${str}" (expected YYYY-MM-DD)`);
  }

  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));

  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new Error(`Invalid date: "${str}"`);
  }

  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

// Accepts a comma-separated list of single dates and/or ranges
// ("start:end"). Ranges expand to all weekdays in [start, end],
// skipping weekends. Returns a deduplicated, sorted list.
function parseDates(arg) {
  const tokens = (arg || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const dates = new Set();

  for (const token of tokens) {
    if (token.includes(':')) {
      const [startStr, endStr] = token.split(':').map((s) => s.trim());
      const start = parseDate(startStr);
      const end = parseDate(endStr);

      if (start > end) {
        throw new Error(`Range start is after end: "${token}"`);
      }

      for (
        let d = start;
        d <= end;
        d = new Date(d.getTime() + 86400000)
      ) {
        if (!isWeekend(d)) {
          dates.add(formatDate(d));
        }
      }
    } else {
      dates.add(formatDate(parseDate(token)));
    }
  }

  return [...dates].sort();
}

const DATES = parseDates(process.argv[2]);

if (DATES.length === 0) {
  console.error('No dates provided');
  process.exit(1);
}

const {
  BAMBOO_URL,
  BAMBOO_USER,
  BAMBOO_PASSWORD,
  MORNING_START,
  MORNING_END,
  AFTERNOON_START,
  AFTERNOON_END
} = process.env;

function readCsrfToken() {
  return (
    document.querySelector('meta[name="csrf-token"]')?.content ||
    document.querySelector('meta[name="csrf"]')?.content ||
    document.querySelector('input[name="CSRFToken"]')?.value ||
    window.CSRF_TOKEN ||
    window.csrfToken ||
    null
  );
}

async function getCsrfToken(page) {
  let token = null;

  try {
    const handle = await page.waitForFunction(readCsrfToken, null, {
      timeout: 30000
    });

    token = await handle.jsonValue();
  } catch {
    // Fall through to the screenshot + error below
  }

  if (!token) {
    await page.screenshot({
      path: 'debug-no-csrf.png',
      fullPage: true
    });

    throw new Error('Unable to find CSRF token');
  }

  return token;
}

async function detectEmployeeId(page) {
  await open(page, `${BAMBOO_URL}/home`);

  try {
    await page
      .locator('a[href*="/employees/timesheet/"]')
      .first()
      .waitFor({ state: 'attached', timeout: 20000 });


    const href = await page
      .locator('a[href*="/employees/timesheet/"]')
      .first()
      .getAttribute('href');

    const match = href?.match(/id=(\d+)/);

    if (match) {
      return match[1];
    }
  } catch {
    // Ignore and fallback to HTML parsing
  }

  const html = await page.content();

  const match =
    html.match(/\/employees\/timesheet\/\?id=(\d+)/) ||
    html.match(/employee\.php\?id=(\d+)/);

  if (match) {
    return match[1];
  }

  await page.screenshot({
    path: 'debug-home-no-employee-id.png',
    fullPage: true
  });

  throw new Error('Unable to detect employee ID');
}

(async () => {
  let context;

  try {
    for (const key of [
      'BAMBOO_URL',
      'BAMBOO_USER',
      'BAMBOO_PASSWORD'
    ]) {
      if (!process.env[key]) {
        throw new Error(`Missing ${key} in .env`);
      }
    }

    context = await chromium.launchPersistentContext(
      `${process.env.HOME}/.bamboohr-hours/profile`,
      {
        headless: false,
        viewport: {
          width: 1600,
          height: 1000
        }
      }
    );

    const page = await context.newPage();

    console.log('Opening BambooHR...');

    await open(page, `${BAMBOO_URL}/login.php`);

    if (page.url().includes('/login.php')) {
      console.log('Logging in...');

      const email = page.locator('#lemail');

      await email.waitFor({ state: 'visible', timeout: 30000 });
      await email.fill(BAMBOO_USER);
      await page.locator('#password').fill(BAMBOO_PASSWORD);
      await page.locator('#password').press('Enter');

      try {
        await page.waitForURL((url) => !url.pathname.includes('/login.php'), {
          timeout: 30000
        });
      } catch {
        // Fall through to the login-failed check below
      }
    }

    if (page.url().includes('/login.php')) {
      await page.screenshot({
        path: 'debug-login-failed.png',
        fullPage: true
      });

      throw new Error('Login failed');
    }

    const employeeId = await detectEmployeeId(page);

    console.log(`Employee ID: ${employeeId}`);

    const timesheetUrl =
      `${BAMBOO_URL}/employees/timesheet/?id=${employeeId}`;

    console.log('Opening timesheet...');

    await open(page, timesheetUrl);

    const csrfToken = await getCsrfToken(page);

    console.log('CSRF token detected');

    const entries = DATES.flatMap((date, i) => [
      {
        id: null,
        trackingId: i * 2 + 1,
        employeeId: Number(employeeId),
        date,
        start: MORNING_START || '09:00',
        end: MORNING_END || '14:00',
        note: NOTE,
        projectId: null,
        taskId: null,
        breakId: null
      },
      {
        id: null,
        trackingId: i * 2 + 2,
        employeeId: Number(employeeId),
        date,
        start: AFTERNOON_START || '15:00',
        end: AFTERNOON_END || '18:00',
        note: NOTE,
        projectId: null,
        taskId: null,
        breakId: null
      }
    ]);

    const payload = { entries };

    console.log('Submitting time entries...');

    const response = await page.request.post(
      `${BAMBOO_URL}/timesheet/clock/entries`,
      {
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json;charset=UTF-8',
          origin: BAMBOO_URL,
          referer: timesheetUrl,
          'x-csrf-token': csrfToken
        },
        data: payload
      }
    );

    const body = await response.text();

    if (!response.ok()) {
      console.error('\n❌ BambooHR Error');
      console.error(`Status: ${response.status()}`);
      console.error(`Response: ${body}`);

      process.exitCode = 1;
      return;
    }

    console.log(`✅ Hours successfully submitted for ${DATES.join(', ')}`);
  } catch (err) {
    console.error('\n❌ Unexpected error');
    console.error(err.message);

    process.exitCode = 1;
  } finally {
    if (context) {
      try {
        await context.close();
        console.log('🔒 Browser closed');
      } catch {
        // Ignore browser close errors
      }
    }
  }
})();
