#!/usr/bin/env node
/* Question bank maintenance (run with Node from the repo root).

   node tools/qb.js add <batch.json>
       batch.json is an array of { "pool", "sub", "stem", "ref" }.
       "stem" is the question text (used only to build the fingerprint,
       never saved). "ref" is an optional short label such as "Q14".
       Each "sub" is checked against the pool's home exam in examData.js.

   node tools/qb.js test <examId> <paste.txt>
       Runs a Tampermonkey-style paste through the same bank lookup the
       page uses and prints which subtopic each question maps to.

   node tools/qb.js list
       Shows how many questions are mapped to each subtopic, per pool. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const QB_FILE = path.join(ROOT, 'questionBank.js');
const START = '/*QB-DATA-START*/';
const END = '/*QB-DATA-END*/';

function loadQB() {
  delete require.cache[require.resolve(QB_FILE)];
  return require(QB_FILE);
}

function loadExams() {
  const win = {};
  new Function('window', fs.readFileSync(path.join(ROOT, 'examData.js'), 'utf8'))(win);
  return win.EXAM_DATA;
}

function findTopicForSub(exam, subName) {
  for (const [topicName, subs] of Object.entries(exam.topics)) {
    if (Object.prototype.hasOwnProperty.call(subs, subName)) return topicName;
  }
  return null;
}

function saveData(data) {
  const src = fs.readFileSync(QB_FILE, 'utf8');
  const a = src.indexOf(START), b = src.indexOf(END);
  if (a < 0 || b < 0) throw new Error('QB-DATA markers not found in questionBank.js');
  const body = '\n  const DATA = ' + JSON.stringify(data, null, 2).replace(/\n/g, '\n  ') + ';\n  ';
  fs.writeFileSync(QB_FILE, src.slice(0, a + START.length) + body + src.slice(b));
}

// Same parser as index.html (parsePastedQuestions), kept in sync by hand.
function parsePasted(raw) {
  const text = (raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  return text.split(/\n(?=\d+\)\s)/).map(p => p.trim()).filter(Boolean).map(part => {
    const m = part.match(/^\d+\)\s*([\s\S]*?)\n\s*Your Answer:/);
    return m ? m[1].trim() : part.split(/\n\s*Your Answer:/)[0].replace(/^\d+\)\s*/, '').trim();
  }).filter(Boolean);
}

const [cmd, ...args] = process.argv.slice(2);
const QB = loadQB();
const exams = loadExams();

if (cmd === 'add') {
  const batch = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  const data = QB.DATA;
  let added = 0, replaced = 0;
  const problems = [];
  for (const [i, item] of batch.entries()) {
    const home = data.poolHomeExam[item.pool];
    if (!home) { problems.push(`#${i + 1}: unknown pool "${item.pool}"`); continue; }
    if (!findTopicForSub(exams[home], item.sub)) {
      problems.push(`#${i + 1}: "${item.sub}" is not a subtopic in ${home}`); continue;
    }
    const fp = QB.fingerprint(item.stem);
    // Very short stems ("DEP" is the...) can still be loaded with "allowShort": true.
    // They only match when every word chunk is present, like all short entries.
    if (fp.length < 4 && !item.allowShort) { problems.push(`#${i + 1}: stem too short to fingerprint reliably (set "allowShort": true to load it anyway)`); continue; }
    const list = data.pools[item.pool];
    // Same question loaded again: replace its mapping instead of adding a duplicate.
    const dup = list.findIndex(e => QB.containment(e.fp, new Set(fp)) >= 0.9 && QB.containment(fp, new Set(e.fp)) >= 0.9);
    const entry = { sub: item.sub, ref: item.ref || '', fp };
    if (dup >= 0) { list[dup] = entry; replaced++; } else { list.push(entry); added++; }
  }
  if (problems.length) {
    console.log('Nothing saved. Fix these first:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  saveData(data);
  console.log(`Saved. ${added} added, ${replaced} replaced.`);
} else if (cmd === 'test') {
  const exam = exams[args[0]];
  if (!exam) { console.log('Unknown exam id. Use one of: ' + Object.keys(exams).join(', ')); process.exit(1); }
  parsePasted(fs.readFileSync(args[1], 'utf8')).forEach((stem, i) => {
    const hit = QB.match(args[0], stem, n => !!findTopicForSub(exam, n));
    console.log(`Q${i + 1}: ` + (hit
      ? `${findTopicForSub(exam, hit.subName)} / ${hit.subName}  [${hit.pool}${hit.ref ? ' ' + hit.ref : ''}, score ${hit.score.toFixed(2)}]`
      : 'not in bank (page will fall back to keyword guess)'));
  });
} else if (cmd === 'list') {
  for (const [pool, list] of Object.entries(QB.DATA.pools)) {
    console.log(`${pool}: ${list.length} question(s)`);
    const by = {};
    list.forEach(e => { (by[e.sub] = by[e.sub] || []).push(e.ref || '?'); });
    Object.entries(by).forEach(([sub, refs]) => console.log(`   ${sub}: ${refs.length}  (${refs.join(', ')})`));
  }
} else {
  console.log('Usage: node tools/qb.js add <batch.json> | test <examId> <paste.txt> | list');
}
