const base = 'http://127.0.0.1:8888';

async function mustJson(path) {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

async function run() {
  const home = await fetch(base + '/').then(r => r.text());
  const required = ['btnRunOnce', 'btnDiagnose', 'runOnce()', 'refreshAll()'];
  for (const k of required) {
    if (!home.includes(k)) throw new Error(`home missing ${k}`);
  }
  if (home.includes("join('\n')")) {
    // should be escaped in template payload as \\n in source, resulting '\\n' in served JS string literal text
  }

  const [a, r, s] = await Promise.all([
    mustJson('/api/analytics'),
    mustJson('/api/rewind'),
    mustJson('/api/system-info'),
  ]);

  if (!a.ok || !r.ok || !s.ok) throw new Error('api not ok');
  console.log('ui-smoke:ok');
}

run().catch((e) => {
  console.error('ui-smoke:fail', e.message);
  process.exit(1);
});
