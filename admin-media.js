/* admin-media.js — ADM13 مركز الوسائط (قراءة فقط) */
(function () {
'use strict';
/* ====== اضبط هذا القسم عند الحاجة ======
   buckets: أسماء الـ buckets (إن تركتها فارغة يحاول قراءتها تلقائياً)
   publicBuckets: الـ buckets العامة فقط (لا تظهر معاينة إلا لها)
   sources: لربط الملف بالسجل الذي يستخدمه، مثال:
   {label:'إعلان', kind:'ads', table:'listings', idCol:'id', cols:['image_url'], link:'#...{id}'}
   kind: ads أو home أو biz.  link يجب أن يبدأ بـ # (اختياري)
   url / key: اختياري، فقط إن فشل الاكتشاف التلقائي (المفتاح العام anon فقط) */
var CONFIG = { buckets: [], publicBuckets: [], sources: [], url: '', key: '' };
var MAXF = 600, PAGE = 48;
var S, client = null;

function init() { S = { files: [], notes: [], trunc: false, usageOK: false, failed: 0, shown: PAGE, q: '', type: '', bucket: '', days: 0, sort: 'new' }; }
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmtSize(n) { if (n == null || isNaN(n)) return 'غير معروف'; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(2) + ' MB'; }
function fmtDate(d) { var x = new Date(d); return (!d || isNaN(x)) ? 'غير معروف' : x.toLocaleDateString('ar', { year: 'numeric', month: 'short', day: 'numeric' }); }
function kindOf(f) {
  var m = (f.mime || '').toLowerCase(), e = (f.name.split('.').pop() || '').toLowerCase();
  if (m.indexOf('image/') === 0 || /^(jpe?g|png|webp|gif|avif|svg)$/.test(e)) return 'image';
  if (m === 'application/pdf' || e === 'pdf') return 'pdf';
  return 'other';
}
var KL = { image: 'صورة', pdf: 'PDF', other: 'ملف آخر' };

/* ---------- عميل Supabase ---------- */
function isServiceKey(k) { try { return JSON.parse(atob(k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role'; } catch (e) { return false; } }
function scan(o, r) {
  if (!o || typeof o !== 'object') return;
  Object.keys(o).forEach(function (p) {
    var v; try { v = o[p]; } catch (e) { return; }
    if (typeof v !== 'string') return;
    if (!r.url && /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/i.test(v)) r.url = v;
    if (!r.key && (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v) || /^sb_publishable_/.test(v))) r.key = v;
  });
}
function getClient() {
  var n = ['sb', 'supabase', 'supabaseClient', 'sbClient', '_sb', 'db', 'supa'];
  for (var i = 0; i < n.length; i++) { var c = window[n[i]]; if (c && c.storage && typeof c.from === 'function') return c; }
  var r = { url: CONFIG.url, key: CONFIG.key }, g = {};
  try { if (typeof SUPABASE_URL !== 'undefined') g.a = SUPABASE_URL; } catch (e) {}
  try { if (typeof SUPABASE_ANON_KEY !== 'undefined') g.b = SUPABASE_ANON_KEY; } catch (e) {}
  try { if (typeof SUPABASE_KEY !== 'undefined') g.c = SUPABASE_KEY; } catch (e) {}
  scan(g, r); scan(window, r);
  Object.keys(window).forEach(function (p) { if (/supa|config|bahr/i.test(p)) { try { scan(window[p], r); } catch (e) {} } });
  if (!r.url || !r.key || isServiceKey(r.key)) return null;
  if (!window.supabase || !window.supabase.createClient) return null;
  return window.supabase.createClient(r.url, r.key);
}

/* ---------- التحميل ---------- */
async function walk(b, prefix, depth) {
  var off = 0;
  while (S.files.length < MAXF) {
    var r = await client.storage.from(b.name).list(prefix, { limit: 100, offset: off, sortBy: { column: 'created_at', order: 'desc' } });
    if (r.error) { S.notes.push('تعذّرت قراءة ' + b.name + (prefix ? '/' + prefix : '') + ': ' + r.error.message); return; }
    var d = r.data || [];
    for (var i = 0; i < d.length; i++) {
      var it = d[i];
      if (S.files.length >= MAXF) { S.trunc = true; return; }
      var path = (prefix ? prefix + '/' : '') + it.name;
      if (it.id) {
        var md = it.metadata || {};
        S.files.push({ bucket: b.name, pub: b.pub, path: path, name: it.name, size: md.size, mime: md.mimetype, created: it.created_at, use: [], failed: false });
      } else if (depth < 3) { await walk(b, path, depth + 1); }
    }
    if (d.length < 100) return;
    off += 100;
  }
  S.trunc = true;
}
function matches(v, f) {
  var i = v.indexOf(f.path);
  if (i < 0) return false;
  if (i > 0 && v.charAt(i - 1) !== '/') return false;
  var e = v.charAt(i + f.path.length);
  return e === '' || e === '?' || e === '#';
}
async function loadUsage() {
  if (!CONFIG.sources.length) return;
  var ok = true;
  for (var s = 0; s < CONFIG.sources.length; s++) {
    var src = CONFIG.sources[s], idc = src.idCol || 'id';
    var r = await client.from(src.table).select([idc].concat(src.cols).join(',')).limit(3000);
    if (r.error) { ok = false; S.notes.push('تعذّرت قراءة ' + src.table + ': ' + r.error.message); continue; }
    if ((r.data || []).length >= 3000) { ok = false; S.notes.push('جدول ' + src.table + ' أكبر من الحد المقروء، فنتائج الربط جزئية.'); }
    (r.data || []).forEach(function (row) {
      var vals = [];
      src.cols.forEach(function (c) { var v = row[c]; if (Array.isArray(v)) vals = vals.concat(v); else if (v) vals.push(v); });
      vals = vals.map(String);
      S.files.forEach(function (f) {
        if (vals.some(function (v) { return matches(v, f); })) {
          var lk = (src.link && src.link.charAt(0) === '#') ? src.link.replace('{id}', encodeURIComponent(row[idc])) : '';
          f.use.push({ label: src.label, kind: src.kind, id: row[idc], link: lk });
        }
      });
    });
  }
  S.usageOK = ok;
}
async function load() {
  var box = $('adm'); init();
  box.innerHTML = '<div class="mc-msg">جارٍ تحميل الملفات…</div>';
  client = getClient();
  if (!client) { box.innerHTML = '<div class="mc-msg">لم يُعثر على عميل Supabase تلقائياً. لم يُعرض أي ملف. ضع الرابط والمفتاح العام (anon فقط) في CONFIG أعلى admin-media.js، أو أرسل لي الرسالة لأضبط الاكتشاف.</div>'; return; }
  try {
    var bl = [];
    if (CONFIG.buckets.length) bl = CONFIG.buckets.map(function (n) { return { name: n, pub: CONFIG.publicBuckets.indexOf(n) > -1 }; });
    else {
      var lb = await client.storage.listBuckets();
      if (lb.error) { box.innerHTML = '<div class="mc-msg">تعذّرت قراءة قائمة الـ buckets (' + esc(lb.error.message) + '). اكتب أسماءها في CONFIG.buckets.</div>'; return; }
      bl = (lb.data || []).map(function (b) { return { name: b.name, pub: !!b.public || CONFIG.publicBuckets.indexOf(b.name) > -1 }; });
    }
    for (var i = 0; i < bl.length; i++) await walk(bl[i], '', 0);
    await loadUsage();
  } catch (e) { S.notes.push('خطأ غير متوقع: ' + e.message); }
  S.files.forEach(function (f, i) { f.i = i; });
  box.innerHTML = shell();
  var bs = $('mc-b'); bs.innerHTML = '<option value="">كل المصادر</option>';
  S.files.map(function (f) { return f.bucket; }).filter(function (v, i, a) { return a.indexOf(v) === i; })
    .forEach(function (n) { bs.insertAdjacentHTML('beforeend', '<option value="' + esc(n) + '">' + esc(n) + '</option>'); });
  update();
}

/* ---------- العرض ---------- */
function shell() {
  return '<div class="mc" id="mc"><div><h3>مركز الوسائط</h3><p class="mc-sub">عرض للقراءة فقط للملفات الموجودة فعلاً في التخزين.</p></div>' +
    '<div class="mc-stats" id="mc-stats"></div><div class="mc-note" id="mc-notes"></div>' +
    '<div class="mc-bar"><input id="mc-q" type="search" placeholder="ابحث باسم الملف أو المسار" aria-label="بحث">' +
    '<select id="mc-t" aria-label="النوع"><option value="">كل الأنواع</option><option value="image">صور</option><option value="pdf">PDF</option><option value="other">ملفات أخرى</option></select>' +
    '<select id="mc-b" aria-label="المصدر"></select>' +
    '<select id="mc-d" aria-label="تاريخ الإضافة"><option value="0">كل التواريخ</option><option value="7">آخر 7 أيام</option><option value="30">آخر 30 يوماً</option></select>' +
    '<select id="mc-s" aria-label="الفرز"><option value="new">الأحدث</option><option value="old">الأقدم</option><option value="name">الاسم</option><option value="size">الأكبر حجماً</option></select></div>' +
    '<div id="mc-lib"></div><div id="mc-rev"></div></div>';
}
function card(l, v, na) { return '<div class="mc-st' + (na ? ' na' : '') + '"><b>' + esc(v) + '</b><span>' + esc(l) + '</span></div>'; }
function cnt(k) { return CONFIG.sources.some(function (s) { return s.kind === k; }) && S.usageOK ? S.files.filter(function (f) { return f.use.some(function (u) { return u.kind === k; }); }).length : null; }
function stats() {
  var n = S.files.length, img = S.files.filter(function (f) { return kindOf(f) === 'image'; }).length;
  var h = card('الملفات المقروءة' + (S.trunc ? ' (جزئي، الحد ' + MAXF + ')' : ''), n) + card('الصور', img) + card('ملفات أخرى', n - img);
  [['ads', 'صور مستخدمة في الإعلانات'], ['home', 'صور الصفحة الرئيسية'], ['biz', 'ملفات الأنشطة التجارية']].forEach(function (x) { var c = cnt(x[0]); h += card(x[1], c == null ? 'غير متاح' : c, c == null); });
  var un = (S.usageOK && !S.trunc) ? S.files.filter(function (f) { return !f.use.length; }).length : null;
  h += card('بلا سجل معروف', un == null ? 'غير متاح' : un, un == null) + card('فشل تحميل المعاينة (التي ظهرت فقط)', S.failed);
  $('mc-stats').innerHTML = h;
}
function notes() {
  var h = '<b>ما لم يُنفَّذ في هذه الواجهة:</b><ul><li>الرفع والحذف والأرشفة واستبدال صور الصفحة الرئيسية: غير مفعّلة لعدم تأكيد حماية الخلفية.</li><li>مساحة التخزين الكلية والصور المصغّرة: غير متاحة.</li><li>الملفات المرتبطة بإعلان مرفوع أو متوقف والملفات المُبلَّغ عنها: غير مدعومة بعد.</li>' +
    (CONFIG.sources.length ? '' : '<li>مكان الاستخدام غير معروف لأن CONFIG.sources فارغ.</li>') + '</ul>';
  if (S.notes.length) h += '<b>تنبيهات القراءة:</b><ul>' + S.notes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  $('mc-notes').innerHTML = h;
}
function filtered() {
  var now = Date.now(), q = S.q.toLowerCase();
  var a = S.files.filter(function (f) {
    if (S.type && kindOf(f) !== S.type) return false;
    if (S.bucket && f.bucket !== S.bucket) return false;
    if (q && (f.name + ' ' + f.path).toLowerCase().indexOf(q) < 0) return false;
    if (S.days) { var t = Date.parse(f.created); if (isNaN(t) || now - t > S.days * 864e5) return false; }
    return true;
  });
  var d = function (f) { return Date.parse(f.created) || 0; };
  a.sort(function (x, y) {
    if (S.sort === 'old') return d(x) - d(y);
    if (S.sort === 'name') return x.name.localeCompare(y.name, 'ar');
    if (S.sort === 'size') return (y.size || 0) - (x.size || 0);
    return d(y) - d(x);
  });
  return a;
}
function purl(f) { return client.storage.from(f.bucket).getPublicUrl(f.path).data.publicUrl; }
function thumb(f) {
  if (kindOf(f) !== 'image') return KL[kindOf(f)];
  if (!f.pub) return 'معاينة غير متاحة (bucket خاص أو غير معروف)';
  if (f.failed) return 'تعذّر تحميل المعاينة';
  return '<img loading="lazy" alt="" data-i="' + f.i + '" src="' + esc(purl(f)) + '">';
}
function useText(f) { return f.use.length ? f.use.map(function (u) { return u.label; }).join('، ') : (S.usageOK ? 'غير مرتبط بسجل معروف' : 'غير معروف'); }
function lib() {
  var all = filtered(), a = all.slice(0, S.shown);
  if (!all.length) { $('mc-lib').innerHTML = '<div class="mc-msg">' + (S.files.length ? 'لا نتائج مطابقة للفلاتر.' : 'لا توجد ملفات في المصادر المقروءة.') + '</div>'; return; }
  var im = a.filter(function (f) { return kindOf(f) === 'image'; }), ot = a.filter(function (f) { return kindOf(f) !== 'image'; });
  var h = '';
  if (im.length) h += '<div class="mc-grid">' + im.map(function (f) { return '<button type="button" class="mc-card" data-act="open" data-i="' + f.i + '"><span class="mc-th">' + thumb(f) + '</span><b>' + esc(f.name) + '</b><small>' + esc(f.bucket) + ' · ' + fmtSize(f.size) + '</small></button>'; }).join('') + '</div>';
  if (ot.length) h += '<div class="mc-tbl"><table><thead><tr><th>الاسم</th><th>النوع</th><th>الحجم</th><th>الإضافة</th><th>الاستخدام</th><th></th></tr></thead><tbody>' +
    ot.map(function (f) { return '<tr><td>' + esc(f.name) + '</td><td>' + KL[kindOf(f)] + '</td><td>' + fmtSize(f.size) + '</td><td>' + fmtDate(f.created) + '</td><td>' + esc(useText(f)) + '</td><td><button type="button" class="mc-btn" data-act="open" data-i="' + f.i + '">تفاصيل</button></td></tr>'; }).join('') + '</tbody></table></div>';
  if (all.length > a.length) h += '<button type="button" class="mc-btn" data-act="more">عرض المزيد (' + (all.length - a.length) + ')</button>';
  $('mc-lib').innerHTML = h;
}
function rev() {
  var map = {}, groups = [];
  S.files.forEach(function (f) { if (f.size == null) return; var k = f.name + '|' + f.size; (map[k] = map[k] || []).push(f); });
  Object.keys(map).forEach(function (k) { if (map[k].length > 1) groups.push(map[k]); });
  var li = function (f) { return '<li>' + esc(f.bucket + '/' + f.path) + ' <button type="button" class="mc-btn" data-act="open" data-i="' + f.i + '">تفاصيل</button></li>'; };
  var h = '<div class="mc-note"><b>مراجعة الملفات</b><br>هذه مؤشرات للمراجعة فقط، وليست مخالفة تلقائياً. والمراجعة الفعلية تتبع صلاحية مراجعة الإعلان أو النشاط نفسه.<ul>';
  h += groups.length ? '<li>تطابق في الاسم والحجم (احتمال تكرار): ' + groups.length + ' مجموعة<ul>' + groups.slice(0, 10).map(function (g) { return '<li>' + g.map(function (f) { return esc(f.path); }).join(' ≈ ') + ' <button type="button" class="mc-btn" data-act="open" data-i="' + g[0].i + '">تفاصيل</button></li>'; }).join('') + '</ul></li>' : '<li>لا تطابقات ظاهرة في الاسم والحجم.</li>';
  if (S.usageOK && !S.trunc) { var un = S.files.filter(function (f) { return !f.use.length; }); h += '<li>ملفات بلا سجل معروف: ' + un.length + (un.length ? '<ul>' + un.slice(0, 20).map(li).join('') + '</ul>' : '') + '</li>'; }
  else h += '<li>الملفات بلا سجل معروف: غير متاح (يحتاج ضبط CONFIG.sources وقراءة كاملة).</li>';
  h += '<li>ملفات إعلانات مرفوضة أو متوقفة أو مُبلَّغ عنها: غير مدعوم بعد.</li></ul></div>';
  $('mc-rev').innerHTML = h;
}
function update() { stats(); notes(); lib(); rev(); }

/* ---------- التفاصيل ---------- */
function closeD() { var o = $('mc-ov'); if (o) o.remove(); }
function openD(f) {
  closeD();
  var acc = kindOf(f) === 'image' && f.pub ? (f.failed ? 'تعذّر الوصول للمعاينة' : 'لم يُختبر بعد (يظهر نتيجة تحميل المعاينة)') : 'لم يُختبر';
  var row = function (a, b) { return '<dt>' + a + '</dt><dd>' + esc(b) + '</dd>'; };
  var links = f.use.filter(function (u) { return u.link; }).map(function (u) { return '<a class="mc-btn" data-act="close" href="' + esc(u.link) + '">فتح السجل: ' + esc(u.label) + '</a>'; }).join(' ');
  var o = document.createElement('div'); o.className = 'mc-ov'; o.id = 'mc-ov';
  o.innerHTML = '<div class="mc-dlg" role="dialog" aria-modal="true" aria-label="تفاصيل الملف"><button type="button" class="mc-x" data-act="close" aria-label="إغلاق">×</button><div class="mc-th">' + thumb(f) + '</div><dl class="mc-dl">' +
    row('الاسم', f.name) + row('النوع', KL[kindOf(f)] + (f.mime ? ' (' + f.mime + ')' : '')) + row('الحجم', fmtSize(f.size)) + row('المصدر', f.bucket) + row('المسار', f.path) + row('تاريخ الإضافة', fmtDate(f.created)) + row('الاستخدام', useText(f)) + row('إمكانية الوصول', acc) + row('صاحب الملف', 'غير متاح') + '</dl>' + (links ? '<p>' + links + '</p>' : '') + '</div>';
  document.body.appendChild(o);
  var x = o.querySelector('.mc-x'); if (x) x.focus();
}

/* ---------- الأحداث (مرة واحدة) ---------- */
document.addEventListener('click', function (e) {
  var nav = e.target.closest && e.target.closest('[data-t="adm13"]');
  if (nav) {
    var adl = $('adl');
    if (!adl || adl.style.display === 'none') return;
    e.preventDefault(); e.stopImmediatePropagation();
    document.querySelectorAll('#adsub button').forEach(function (b) { b.classList.remove('on'); });
    nav.classList.add('on');
    var m = $('admsg'); if (m) m.textContent = '';
    load(); return;
  }
  if (e.target === $('mc-ov')) { closeD(); return; }
  var a = e.target.closest && e.target.closest('[data-act]');
  if (!a || !(a.closest('#mc') || a.closest('#mc-ov'))) return;
  var act = a.getAttribute('data-act');
  if (act === 'close') closeD();
  else if (act === 'open') openD(S.files[+a.getAttribute('data-i')]);
  else if (act === 'more') { S.shown += PAGE; lib(); }
}, true);
document.addEventListener('input', function (e) { if (e.target.id === 'mc-q') { S.q = e.target.value; S.shown = PAGE; lib(); } });
document.addEventListener('change', function (e) {
  var m = { 'mc-t': 'type', 'mc-b': 'bucket', 'mc-d': 'days', 'mc-s': 'sort' }[e.target.id];
  if (!m) return;
  S[m] = m === 'days' ? +e.target.value : e.target.value; S.shown = PAGE; lib();
});
document.addEventListener('error', function (e) {
  var t = e.target;
  if (!t || t.tagName !== 'IMG' || t.getAttribute('data-i') == null || !t.closest('#mc')) return;
  var f = S.files[+t.getAttribute('data-i')];
  if (f && !f.failed) { f.failed = true; S.failed++; stats(); }
  t.replaceWith(document.createTextNode('تعذّر تحميل المعاينة'));
}, true);
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeD(); });
init();
})();
