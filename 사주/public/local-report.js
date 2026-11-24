const api = '/__local/reports';

async function request(path, options) {
  const response = await fetch(api + path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || '리포트를 불러오지 못했습니다.');
  return data;
}

function item(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function link(text, href) {
  const node = item('a', text);
  node.href = href;
  return node;
}

function addEntry() {
  const nativeForm = /^\/bot\/(\d+)\/form\/?$/.exec(location.pathname);
  const box = location.pathname === '/box' || location.pathname === '/reports';
  const href = nativeForm ? '/local-reports/new?bot=' + nativeForm[1] : box ? '/local-reports' : null;
  let entry = document.querySelector('#local-report-entry');
  if (!href) return entry?.remove();
  if (entry?.getAttribute('href') === href) return;
  if (!entry) {
    entry = link('', href);
    entry.id = 'local-report-entry';
    document.body.append(entry);
  }
  entry.href = href;
  entry.textContent = nativeForm ? '로컬 서버 리포트 만들기' : '로컬 서버 리포트 보관함';
}

async function showReports(content) {
  const reports = await request('');
  if (!reports.length) return content.append(item('p', '이 브라우저에서 생성한 리포트가 없습니다.'));
  const list = item('ul', '');
  for (const report of reports) {
    const entry = item('li', '');
    entry.append(link(report.title, '/local-reports/' + report.id));
    list.append(entry);
  }
  content.append(list);
}

async function showReport(content, id) {
  const report = await request('/' + id);
  content.querySelector('h1').textContent = report.title;
  for (const section of report.sections) {
    const card = item('section', '');
    card.append(item('h2', section.heading), item('p', section.text));
    content.append(card);
  }
}

function attachForm(form, status) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    status.textContent = '서버에서 리포트를 생성 중입니다…';
    const fields = Object.fromEntries(new FormData(form));
    try {
      const report = await request('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_id: Number(fields.bot_id), input_json: fields }),
      });
      location.assign('/local-reports/' + report.id);
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
}

const content = document.querySelector('#local-report-content');
const form = document.querySelector('#local-report-form');
if (content) {
  const status = document.querySelector('#local-report-status');
  if (form) {
    attachForm(form, status);
  } else {
    const report = location.pathname.match(/^\/local-reports\/([a-f0-9-]+)$/)?.[1];
    (report ? showReport(content, report) : showReports(content)).catch((error) => {
      status.textContent = error.message;
    });
  }
} else {
  addEntry();
  new MutationObserver(addEntry).observe(document.body, { childList: true, subtree: true });
}
