const calendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
});
const stems = '甲乙丙丁戊己庚辛壬癸';
const branches = '子丑寅卯辰巳午未申酉戌亥';
const koreanStems = '갑을병정무기경신임계';
const koreanBranches = '자축인묘진사오미신유술해';
// The observed public API returned 壬寅 for 2026-11-24 in Seoul.
const referenceDay = Date.UTC(2026, 10, 24);

export function dailyIlju(now = new Date()) {
  const parts = Object.fromEntries(calendar.formatToParts(now).map(({ type, value }) => [type, value]));
  const day = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const elapsed = (day - referenceDay) / 86400000;
  const stem = ((elapsed + 8) % stems.length + stems.length) % stems.length;
  const branch = ((elapsed + 2) % branches.length + branches.length) % branches.length;
  const ilju = koreanStems[stem] + koreanBranches[branch];
  return {
    date: new Date(day).toISOString().slice(0, 10).replaceAll('-', ''),
    gan: stems[stem],
    ji: branches[branch],
    ilju,
    ilj: ilju,
  };
}
