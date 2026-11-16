/** Loads a year's tax rules from the site's own public JSON files (the same ones the browser uses). */
export async function fetchRules(req, financialYear = '2025-26') {
  const fy = String(financialYear).replace(/[^0-9-]/g, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
  const res = await fetch(`${proto}://${host}/rules/fy${fy}.json`);
  if (!res.ok) throw new Error(`no tax rules for ${fy}`);
  return res.json();
}
