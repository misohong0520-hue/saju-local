import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dailyIlju } from './daily-ilju.mjs';

const reportId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ownerCookie = 'yongyong_local_reports';
const topics = {
  '갑을': ['새로운 일의 시작', '오늘 시작할 수 있는 가장 작은 행동을 정해 보세요.'],
  '병정': ['표현과 연결', '중요한 사람에게 바라는 것을 구체적인 문장으로 이야기해 보세요.'],
  '무기': ['꾸준한 변화', '반복하기 쉬운 습관 하나를 정하고 일주일 동안 지켜보세요.'],
  '경신': ['기준 정리', '꼭 지키고 싶은 조건과 조정할 수 있는 조건을 나눠 보세요.'],
  '임계': ['관찰과 조율', '상대의 마음을 짐작하기 전에 사실과 추측을 따로 적어보세요.'],
};
const questionTopics = [
  [/재회|전남친|전여친|이별/, '다시 연락하기 전에 이전 관계에서 해결되지 않았던 문제와 지금 달라진 점을 각각 한 가지씩 적어보세요.'],
  [/연애|궁합|결혼|관계|마음|연락/, '상대가 어떻게 생각할지 짐작하기보다, 다음 대화에서 편하게 확인할 수 있는 질문 한 가지를 골라보세요.'],
  [/이직|직장|취업|직업|진로/, '다음 선택지마다 배우는 것, 일하는 조건, 감당할 비용을 적고 직접 확인할 수 있는 항목부터 확인해 보세요.'],
  [/재물|금전|지출|돈/, '이번 주에 실제로 확인할 수 있는 수입과 지출부터 나누고, 바꿀 수 있는 항목 하나를 정해 보세요.'],
];

function birth(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T12:00:00+09:00');
  return Number.isFinite(+date) && value.replaceAll('-', '') <= dailyIlju().date &&
    date.toISOString().slice(0, 10) === value && value >= '1900-01-01' ? date : null;
}

function textField(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export function generateReport(input, title) {
  const date = birth(input?.birth_date);
  if (!date) return null;
  const solar = input.calendar !== 'lunar' && input.calendar !== '음력';
  const ilju = solar ? dailyIlju(date).ilju : null;
  const [focus, advice] = ilju
    ? Object.entries(topics).find(([stem]) => stem.includes(ilju[0]))[1]
    : ['계절과 변화', '요즘 달라진 생활 리듬과 편안하게 느끼는 시간을 적어보세요.'];
  const partner = birth(input.partner_birth_date);
  const partnerCalendar = input.partner_calendar;
  const partnerIlju = partner && partnerCalendar !== 'lunar' && partnerCalendar !== '음력'
    ? dailyIlju(partner).ilju : null;
  const question = textField(input.question ?? input.concern ?? input.concerns, 300);
  const sections = [
    { heading: '입력값 해석', text: ilju
      ? '입력한 양력 날짜의 일주는 ' + ilju + '입니다. 이 리포트는 일주를 바탕으로 읽을거리를 구성했습니다.'
      : '음력 입력은 날짜를 양력으로 환산하지 않고 계절과 생활 리듬을 주제로 구성했습니다.' },
    { heading: focus, text: advice },
  ];
  if (partner) sections.push({
    heading: '두 사람의 관계',
    text: partnerIlju ? '상대의 양력 일주는 ' + partnerIlju + '입니다. 서로가 편하게 느끼는 연락 간격과 대화 시간을 비교해 보세요.'
      : '두 사람의 생활 리듬을 비교하고, 서로 맞춰볼 만한 작은 약속을 골라보세요.',
  });
  const questionAdvice = questionTopics.find(([pattern]) => pattern.test(question || title))?.[1];
  if (questionAdvice || question) sections.push({
    heading: '질문 돌아보기',
    text: questionAdvice ?? '이 고민에서 내가 바꿀 수 있는 행동과 아직 확인해야 할 사실을 한 가지씩 적어보세요.',
  });
  return { title, sections };
}

async function readBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16384) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return null; }
}

function currentOwner(request) {
  const value = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(ownerCookie + '='))?.slice(ownerCookie.length + 1);
  return reportId.test(value ?? '') ? value : null;
}

export function createReportService(folder, localOrigin, botInfo, json) {
  const storage = new URL('local-reports/', folder);
  return async (request, response, url) => {
    const method = request.method;
    const owner = currentOwner(request);
    const path = url.pathname;
    if (request.headers['sec-fetch-site'] === 'cross-site' ||
        (request.headers.origin && request.headers.origin !== localOrigin)) {
      request.resume();
      return json(response, method, 403, { detail: '복제본 화면에서 다시 시도해 주세요.' });
    }
    if (method === 'POST' && path === '/__local/reports') {
      const suppliedLength = Number(request.headers['content-length']);
      if (suppliedLength > 16384) {
        request.resume();
        return json(response, method, 413, { detail: '입력 내용이 너무 깁니다.' });
      }
      const input = await readBody(request);
      const bot = await botInfo(input?.bot_id);
      const generated = bot && generateReport(input.input_json, bot.name);
      if (!generated) return json(response, method, 400, { detail: '상품과 생년월일을 확인해 주세요.' });
      const id = randomUUID();
      const browser = owner ?? randomUUID();
      const report = { id, bot_id: bot.id, created_at: new Date().toISOString(), ...generated };
      const directory = new URL(browser + '/', storage);
      await mkdir(directory, { recursive: true });
      const temp = new URL(id + '.tmp', directory);
      await writeFile(temp, JSON.stringify(report), { flag: 'wx' });
      await rename(temp, new URL(id + '.json', directory));
      if (!owner) response.setHeader('Set-Cookie', ownerCookie + '=' + browser + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000');
      return json(response, method, 201, report);
    }
    if (method === 'GET' && path === '/__local/reports') {
      const directory = owner && new URL(owner + '/', storage);
      const files = directory ? await readdir(directory).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }) : [];
      const reports = await Promise.all(files.filter((file) => reportId.test(file.replace(/\.json$/, '')) && file.endsWith('.json'))
        .map(async (file) => {
          const { id, title, created_at } = JSON.parse(await readFile(new URL(file, directory), 'utf8'));
          return { id, title, created_at };
        }));
      reports.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return json(response, method, 200, reports);
    }
    const id = path.split('/').at(-1);
    if (method === 'GET' && owner && reportId.test(id)) {
      try {
        const report = JSON.parse(await readFile(new URL(owner + '/' + id + '.json', storage), 'utf8'));
        return json(response, method, 200, report);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return json(response, method, 404, { detail: '이 브라우저에 저장된 리포트를 찾을 수 없습니다.' });
  };
}
