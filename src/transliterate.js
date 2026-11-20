// ─── Lyrics transliteration (romanization) ─────────────────────────────────────
// Japanese → Hepburn romaji (kuroshiro + kuromoji, loaded lazily — the
//            dictionary is large, so it's only loaded for Japanese songs)
// Korean   → Revised Romanization (built-in, with the common sound-change rules)
// Chinese  → Pinyin with tone marks (pinyin-pro)
// Others   → any-ascii (Cyrillic, Greek, Arabic, Hebrew, Thai, Devanagari, …)

const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const KANA      = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
const HANGUL    = /[가-힣]/;
const HAN       = /[㐀-䶿一-鿿豈-﫿]/;

const needsTransliteration = (text) => NON_LATIN.test(text || '');

// ── any-ascii for remaining non-Latin runs (keeps accented Latin as-is) ────────
let anyAsciiFn = null;
function anyAscii(s) {
  if (!anyAsciiFn) { const m = require('any-ascii'); anyAsciiFn = m.default || m; }
  return anyAsciiFn(s);
}
const NON_LATIN_RUN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]+/gu;
function asciiRest(s) {
  return s.replace(NON_LATIN_RUN, (run) => anyAscii(run));
}

// ── Korean (Revised Romanization) ──────────────────────────────────────────────
const KO_INITIAL = ['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
const KO_VOWEL   = ['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i'];
const KO_FINAL   = ['','k','k','k','n','n','n','t','l','k','m','l','l','l','p','l','m','p','p','t','t','ng','t','t','k','t','p','t'];
// When a final consonant is followed by ㅇ it moves to the next syllable:
// [what stays, what moves]
const KO_LIAISON = {
  1:['','g'], 2:['','kk'], 3:['k','s'], 4:['','n'], 5:['n','j'], 6:['','n'], 7:['','d'], 8:['','r'],
  9:['l','g'], 10:['l','m'], 11:['l','b'], 12:['l','s'], 13:['l','t'], 14:['l','p'], 15:['','r'],
  16:['','m'], 17:['','b'], 18:['p','s'], 19:['','s'], 20:['','ss'], 22:['','j'], 23:['','ch'],
  24:['','k'], 25:['','t'], 26:['','p'], 27:['',''],
};

function romanizeKorean(text) {
  const chars = [...text];
  const syl = chars.map((c) => {
    const code = c.codePointAt(0) - 0xac00;
    if (code < 0 || code > 11171) return null;
    return { i: Math.floor(code / 588), v: Math.floor((code % 588) / 28), f: code % 28 };
  });
  let out = '';
  for (let n = 0; n < chars.length; n++) {
    const s = syl[n];
    if (!s) { out += chars[n]; continue; }
    const prev = syl[n - 1];
    const next = syl[n + 1];

    // Onset (may have been modified by the previous syllable's final)
    let onset = s.onset !== undefined ? s.onset : KO_INITIAL[s.i];
    if (n === 0 || !prev) {
      if (s.i === 5) onset = 'r'; // word-initial ㄹ is still written r in RR
    }
    out += onset + KO_VOWEL[s.v];

    // Coda
    let coda = KO_FINAL[s.f];
    if (s.f && next) {
      if (next.i === 11 && KO_LIAISON[s.f]) {            // liaison: 사랑을 → sarangeul
        const [stay, move] = KO_LIAISON[s.f];
        coda = stay; next.onset = move;
        if (s.f === 21) { coda = 'ng'; next.onset = ''; }
      } else if (next.i === 2 || next.i === 6) {         // nasalisation before ㄴ/ㅁ
        if (coda === 'k') coda = 'ng';
        else if (coda === 't') coda = 'n';
        else if (coda === 'p') coda = 'm';
        else if (coda === 'l' && next.i === 2) next.onset = 'l'; // ㄹ+ㄴ → ll
      } else if (next.i === 5) {                         // ㄹ after a final
        if (coda === 'l' || coda === 'n') { coda = 'l'; next.onset = 'l'; }
        else if (coda === 'ng' || coda === 'm') next.onset = 'n';
        else if (coda === 'k') { coda = 'ng'; next.onset = 'n'; }
        else if (coda === 'p') { coda = 'm'; next.onset = 'n'; }
        else if (coda === 't') { coda = 'n'; next.onset = 'n'; }
      } else if (next.i === 18 && (coda === 'k' || coda === 't' || coda === 'p')) { // aspiration
        next.onset = { k:'k', t:'t', p:'p' }[coda]; coda = '';
      }
    }
    if (s.f === 27 && next && [0, 3, 12].includes(next.i)) { // ㅎ + ㄱ/ㄷ/ㅈ → k/t/ch
      coda = ''; next.onset = { 0:'k', 3:'t', 12:'ch' }[next.i];
    }
    out += coda;
  }
  return out;
}

// ── Chinese ─────────────────────────────────────────────────────────────────────
let pinyinFn = null;
function romanizeChinese(text) {
  if (!pinyinFn) pinyinFn = require('pinyin-pro').pinyin;
  return pinyinFn(text, { toneType: 'symbol', nonZh: 'consecutive' });
}

// ── Japanese ────────────────────────────────────────────────────────────────────
// Tokenise with kuromoji, then romanise word-by-word ourselves: kuroshiro's own
// "spaced" mode romanises each token separately, which breaks small っ across
// tokens (だった → "datsu ta") and leaves particles like は as "ha".
let jpPromise = null;
function getJapanese() {
  if (!jpPromise) {
    jpPromise = (async () => {
      const KuroshiroMod = require('kuroshiro');
      const Kuroshiro = KuroshiroMod.default || KuroshiroMod;
      const Analyzer  = require('kuroshiro-analyzer-kuromoji');
      // Resolve the dictionary folder directly — the analyzer's own guess is a
      // regex on the module path, which is fragile (and breaks inside asar)
      const path = require('path');
      let dictPath = path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict');
      const unpacked = dictPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      if (unpacked !== dictPath && require('fs').existsSync(unpacked)) dictPath = unpacked;
      const analyzer  = new Analyzer({ dictPath: dictPath + path.sep });
      const t0 = Date.now();
      await analyzer.init();
      console.log(`Japanese dictionary loaded in ${Date.now() - t0}ms from ${dictPath}`);
      return { analyzer, kanaToRomaji: Kuroshiro.Util.kanaToRomaji };
    })().catch((e) => { jpPromise = null; throw e; });
  }
  return jpPromise;
}

// Common lyric words the IPADIC dictionary splits or reads unnaturally
const JA_OVERRIDES = [
  ['二人', 'ふたり'], ['一人', 'ひとり'], ['明日', 'あした'], ['貴方', 'あなた'], ['貴女', 'あなた'],
  ['大人', 'おとな'], ['今日', 'きょう'], ['昨日', 'きのう'], ['一日', 'いちにち'], ['何処', 'どこ'],
];
const JA_PARTICLES = { 'は': 'wa', 'へ': 'e', 'を': 'o' };
const KATA_RX = /[\u30a1-\u30fa\u30fc]/;

async function romanizeJapanese(text) {
  const { analyzer, kanaToRomaji } = await getJapanese();
  let src = text;
  for (const [k, v] of JA_OVERRIDES) src = src.split(k).join(v);
  const tokens = await analyzer.parse(src);

  const groups = [];
  let prev = null;
  for (const t of tokens) {
    const surface = t.surface_form;
    let roman;
    if (t.pos === '助詞' && JA_PARTICLES[surface]) roman = JA_PARTICLES[surface];
    else if (t.reading && t.reading !== '*' && KATA_RX.test(t.reading)) roman = t.reading; // romanised per group below
    else roman = null; // non-Japanese (Latin, numbers, symbols) — keep as written

    const attach = prev && roman !== null && prev.kana !== null && (
      (t.pos === '助動詞' && prev.pos !== '助詞') ||          // だっ+た, ませ+ん (not after a particle)
      (t.pos === '動詞' && t.pos_detail_1 === '非自立' && /^[てでちじ]/.test(surface)) || // 愛し+て+る
      (t.pos === '助詞' && t.pos_detail_1 === '接続助詞') ||   // 言っ+て
      t.pos_detail_1 === '接尾' ||                             // suffixes
      /[ッっ]$/.test(prev.kana)                                // small tsu joins the next sound
    );
    if (roman !== null && JA_PARTICLES[surface] === roman && t.pos === '助詞') {
      groups.push({ kana: null, text: roman });
      prev = { kana: '', pos: t.pos };
      continue;
    }
    if (attach && prev.group) {
      prev.group.kana += roman;
      prev.kana = prev.group.kana;
      prev.pos  = t.pos;
      continue;
    }
    const g = roman !== null ? { kana: roman } : { kana: null, text: surface };
    groups.push(g);
    prev = { kana: g.kana, group: roman !== null ? g : null, pos: t.pos };
  }

  return groups
    .map((g) => (g.kana !== null ? kanaToRomaji(g.kana, 'hepburn') : g.text))
    .join(' ');
}

// ── Public API ──────────────────────────────────────────────────────────────────
function detectLanguage(allText) {
  if (KANA.test(allText))   return 'ja';
  if (HANGUL.test(allText)) return 'ko';
  if (HAN.test(allText))    return 'zh';
  return 'other';
}

const CJK_PUNCT = { '、': ',', '。': '.', '！': '!', '？': '?', '「': '“', '」': '”', '『': '“', '』': '”', '（': '(', '）': ')', '～': '~', '・': ' ', '　': ' ', '，': ',', '：': ':', '；': ';' };
function tidy(s) {
  return s.replace(/[、。！？「」『』（）～・　，：；]/g, (c) => CJK_PUNCT[c] + (/[、。！？，：；]/.test(c) ? ' ' : '')).replace(/\s+/g, ' ').replace(/([“(])\s+/g, '$1').replace(/\s+([”)])/g, '$1').replace(/\s+([,.!?;:)\]」』、。！？])/g, '$1').trim();
}

async function romanize(text, lang) {
  if (!needsTransliteration(text)) return text;
  let r = text;
  if (lang === 'ja' && (KANA.test(r) || HAN.test(r))) r = await romanizeJapanese(r);
  if (HANGUL.test(r)) r = romanizeKorean(r);
  if (HAN.test(r))    r = romanizeChinese(r);
  return tidy(asciiRest(r));
}

// lines: [{ text, words?: [string] }] → [{ text, words? } | null] (null = unchanged)
async function transliterateLines(lines) {
  const all  = lines.map((l) => l.text || '').join('\n');
  if (!needsTransliteration(all)) return { lang: null, lines: lines.map(() => null) };
  const lang = detectLanguage(all);
  const out  = [];
  let error  = null;
  if (lang === 'ja') {
    // Load the Japanese analyzer up front so a setup problem is reported once,
    // clearly, instead of silently leaving every line unchanged
    try { await getJapanese(); }
    catch (e) {
      console.error('Japanese romanization unavailable:', e);
      error = /Cannot find module/.test(e.message)
        ? 'Japanese romanization needs its libraries — run "npm install" in the app folder, then restart.'
        : 'Japanese romanization failed to load: ' + e.message;
      return { lang, lines: lines.map(() => null), error };
    }
  }
  for (const l of lines) {
    if (!l.text || !needsTransliteration(l.text)) { out.push(null); continue; }
    try {
      if (Array.isArray(l.words) && l.words.length) {
        // Keep a 1:1 word mapping so exact word timings still line up
        const words = [];
        for (const w of l.words) words.push((await romanize(w, lang)).replace(/\s+/g, '') || w);
        out.push({ text: words.join(' '), words });
      } else {
        out.push({ text: await romanize(l.text, lang) });
      }
    } catch (e) {
      console.error('Transliteration failed:', e);
      if (!error) error = /Cannot find module/.test(e.message)
        ? 'Romanization needs its libraries — run "npm install" in the app folder, then restart.'
        : 'Romanization failed: ' + e.message;
      out.push(null);
    }
  }
  return { lang, lines: out, error };
}

module.exports = { transliterateLines, needsTransliteration, romanizeKorean };
