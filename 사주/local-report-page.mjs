function escape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function localReportPage(bot, list) {
  const title = bot ? bot.name : list ? '로컬 서버 리포트 보관함' : '로컬 서버 리포트';
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escape(title) + ' · 용용사주 로컬</title>' +
    '<link rel="stylesheet" href="/__local/report.css"><script defer src="/__local/report.js"></script>' +
    '</head><body class="local-report-body"><main id="local-report-content">' +
    '<nav aria-label="페이지 이동"><a href="/">용용사주 홈</a><a href="/local-reports">로컬 리포트 보관함</a>' +
    '<a href="https://yongyong.ai/reports">원본 구매 리포트</a></nav>' +
    '<h1>' + escape(title) + '</h1><p>로컬 서버에서 계산하고 작성하는 리포트입니다.</p>' +
    (bot ? '<form id="local-report-form"><input type="hidden" name="bot_id" value="' + escape(bot.id) + '">' +
      '<label>생년월일 <input type="date" name="birth_date" min="1900-01-01" required></label>' +
      '<label>달력 기준 <select name="calendar"><option value="solar">양력</option><option value="lunar">음력</option></select></label>' +
      '<label>상대 생년월일 (선택) <input type="date" name="partner_birth_date" min="1900-01-01"></label>' +
      '<label>상대 달력 기준 <select name="partner_calendar"><option value="solar">양력</option><option value="lunar">음력</option></select></label>' +
      '<label>고민이 있나요? (선택) <textarea name="question" maxlength="300" rows="3"></textarea></label>' +
      '<button type="submit">서버에서 리포트 생성</button></form>' : '') +
    '<p id="local-report-status" role="status"></p></main></body></html>';
}
