/* ===== ADM11 — BahrNotify: وحدة إشعارات مستقلة (الصقها كما هي في نهاية app.js) =====
   - مستقلة تماماً: تحقن تنسيقها بنفسها (بادئة bnx-) ولا تحتاج تعديل style.css.
   - لا تلمس نظام B45: ممنوع ربطها بـ #bell أو #bc أو #nfp (ترفض ذلك تلقائياً). أضف زرّاً جديداً بـ ID جديد.
   - لا تفترض اسم جدول ولا عميل Supabase: أنت تعرّف source.load وsource.map بنفسك.
   - لا تنشئ بيانات تجريبية: بدون source.load تعرض «لم يُربط مصدر بيانات» ولا تعرض شيئاً.
   - إخفاء الواجهة ليس حماية: الصلاحيات الفعلية تكون من RLS في الخلفية.

   مثال الربط (عدّل الأسماء لتطابق قاعدتك؛ لم أفحص جدولك):
   BahrNotify.mount({
     bell: '#admNtfBell',                 // ID زرّ جديد تضيفه في index.html
     canAccess: function () { return true; },     // اختياري، للواجهة فقط
     userKey: function () { return 'admin'; },    // مفتاح التخزين المحلي لكل مستخدم
     source: {
       load: async function () {
         var r = await YOUR_CLIENT.from('YOUR_TABLE').select('*').order('created_at', { ascending: false }).limit(200);
         if (r.error) throw r.error;
         return r.data;
       },
       map: function (r) { return { id: r.id, type: r.type, title: r.title, body: r.body,
         created_at: r.created_at, read: r.is_read, link: r.link, ref: r.ref_label, severity: r.severity }; },
       markRead: async function (ids) { / * حدّث الصفوف في الخلفية، وارمِ خطأً إن فشل * / }   // اختياري
     }
   });
   BahrNotify.mountPage('#admNtfPage');   // اختياري: عرض الصفحة الكاملة داخل عنصر موجود
   BahrNotify.push(rows);                 // اختياري: من آلية التحديث المباشر الموجودة عندك
*/
(function (w, d) {
  'use strict';
  if (w.BahrNotify) return;

  var PR = { urgent: 'عاجل', important: 'مهم', normal: 'عادي' };
  var PC = { urgent: 'bnx-pu', important: 'bnx-pi', normal: 'bnx-pn' };
  var CATS = { ads: 'الإعلانات', users: 'المستخدمون والتجّار', reports: 'البلاغات والمراجعة',
    orders: 'الطلبات والخدمات', chats: 'المحادثات والاستفسارات', system: 'النظام والأخطاء' };
  var DAYS = { d1: 1, d7: 7, d30: 30 };

  /* قواعد الأولوية صريحة: p = أولوية ثابتة أو دالة تقرأ الحقول. غير ذلك = عادي.
     أسماء type هنا مفاتيح فقط: لا يظهر إشعار إلا إذا أرسل مصدرك صفاً بهذا النوع فعلاً.
     عدّل أو أضف أنواعاً عبر mount({ types: { my_type: { l: 'الاسم', c: 'ads', p: 'normal' } } }). */
  var TYPES = {
    listing_review: { l: 'إعلان يحتاج مراجعة', c: 'ads', p: 'important' },
    verification_request: { l: 'طلب توثيق', c: 'users', p: 'important' },
    report: { l: 'بلاغ أو شكوى', c: 'reports', p: 'important' },
    inquiry: { l: 'استفسار أو رسالة للإدارة', c: 'chats', p: 'normal' },
    order_status: { l: 'تغيّر حالة طلب خدمة', c: 'orders', p: 'normal' },
    campaign_ending: { l: 'اقتراب انتهاء حملة', c: 'ads', p: 'normal' },
    campaign_ended: { l: 'انتهاء حملة', c: 'ads', p: 'normal' },
    tech_error: { l: 'خطأ تقني مسجّل', c: 'system', p: function (it) { return it.sev === 'critical' ? 'urgent' : 'important'; } },
    setting_change: { l: 'تغيير في إعدادات المنصة', c: 'system', p: 'important' },
    admin_review: { l: 'عملية إدارية تحتاج مراجعة', c: 'reports', p: 'important' }
  };

  var cfg = null, bell = null, badgeEl = null, dd = null, busy = false, timer = 0;
  var views = [], prefs = { off: {}, hideNormal: false }, localRead = new Set();
  var S = { items: new Map(), status: 'idle', f: { cat: 'all', q: '', type: '', pr: '', st: '', dt: '' },
    sel: new Set(), open: null, view: 'list', msg: '', hid: 0 };

  /* ---------- أدوات ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeLink(l) { return typeof l === 'string' && /^#[A-Za-z0-9_\-\/.=&?%]*$/.test(l) ? l : ''; }
  function when(s) {
    var t = Date.parse(s);
    if (isNaN(t)) return '';
    try { return new Date(t).toLocaleString('ar-IQ', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return new Date(t).toLocaleString(); }
  }
  function key(n) {
    var u = 'anon';
    try { if (cfg && cfg.userKey) u = String(cfg.userKey()); } catch (e) {}
    return 'bnx:' + u + ':' + n;
  }
  function ld(n, def) { try { var v = w.localStorage.getItem(key(n)); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function sv(n, v) { try { w.localStorage.setItem(key(n), JSON.stringify(v)); return true; } catch (e) { return false; } }

  /* ---------- البيانات ---------- */
  function norm(r) {
    var m = cfg.source && cfg.source.map ? cfg.source.map(r) : r;
    if (!m || m.id == null) return null;
    return { id: String(m.id), type: m.type || '', title: m.title || '', body: m.body || '',
      at: m.created_at || m.at || '', read: !!(m.read || m.read_at), pr: m.priority,
      link: safeLink(m.link), ref: m.ref || '', sev: m.severity, raw: r };
  }
  function isRead(it) { return it.read || localRead.has(it.id); }
  function prio(it) {
    var t = TYPES[it.type], r = t ? t.p : null;
    if (typeof r === 'function') r = r(it);
    if (!PR[r]) r = PR[it.pr] ? it.pr : 'normal';
    return r;
  }
  function cat(it) { return (TYPES[it.type] && TYPES[it.type].c) || 'other'; }
  function typeLabel(it) { return (TYPES[it.type] && TYPES[it.type].l) || it.type || 'حدث'; }
  function unread() {
    var n = 0;
    S.items.forEach(function (it) { if (!prefs.off[it.type] && !isRead(it)) n++; });
    return n;
  }
  function list() {
    var f = S.f, out = [], now = Date.now(), q = f.q.toLowerCase();
    S.hid = 0;
    S.items.forEach(function (it) {
      if (prefs.off[it.type]) return;
      var rd = isRead(it), p = prio(it), c = cat(it);
      if (f.cat === 'unread' && rd) return;
      if (f.cat === 'hot' && p === 'normal') return;
      if (CATS[f.cat] && c !== f.cat) return;
      if (f.type && it.type !== f.type) return;
      if (f.pr && p !== f.pr) return;
      if (f.st === 'unread' && rd) return;
      if (f.st === 'read' && !rd) return;
      if (f.dt) { var t = Date.parse(it.at); if (isNaN(t) || now - t > DAYS[f.dt] * 864e5) return; }
      if (q && (it.title + ' ' + it.body + ' ' + it.ref + ' ' + typeLabel(it)).toLowerCase().indexOf(q) < 0) return;
      if (prefs.hideNormal && f.cat === 'all' && !f.pr && p === 'normal') { S.hid++; return; }
      out.push(it);
    });
    out.sort(function (a, b) { return (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0); });
    return out;
  }

  function load() {
    if (!cfg) return Promise.resolve();
    if (!cfg.source || typeof cfg.source.load !== 'function') { S.status = 'nosrc'; paint(); return Promise.resolve(); }
    if (busy) return Promise.resolve();
    busy = true; S.status = 'loading'; paint();
    return Promise.resolve().then(function () { return cfg.source.load(); }).then(function (rows) {
      var next = new Map();            // المفتاح = id، لذلك لا يتكرر الإشعار عند إعادة التحميل
      (rows || []).forEach(function (r) { var it = norm(r); if (it) next.set(it.id, it); });
      S.items = next; S.status = 'ok';
    }).catch(function () { S.status = 'err'; }).then(function () { busy = false; paint(); });
  }
  function push(rows) {
    if (!cfg) return;
    (rows || []).forEach(function (r) { var it = norm(r); if (it) S.items.set(it.id, it); });
    if (S.status !== 'err') S.status = 'ok';
    paint();
  }
  function markRead(ids) {
    ids = ids.filter(function (i) { var it = S.items.get(i); return it && !isRead(it); });
    if (!ids.length) return Promise.resolve();
    var src = cfg.source, p;
    if (src && typeof src.markRead === 'function') {
      p = Promise.resolve().then(function () { return src.markRead(ids); })
        .then(function () { ids.forEach(function (i) { S.items.get(i).read = true; }); });
    } else {
      p = Promise.resolve().then(function () {
        ids.forEach(function (i) { localRead.add(i); });
        if (!sv('read', Array.from(localRead))) { ids.forEach(function (i) { localRead.delete(i); }); throw new Error('local'); }
      });
    }
    return p.then(function () { S.msg = ''; }, function () { S.msg = 'تعذّر تحديث حالة القراءة، ولم يتغيّر شيء.'; })
      .then(function () { S.sel.clear(); paint(); });
  }

  /* ---------- العرض ---------- */
  function emp(t, c) { return '<p class="bnx-e' + (c ? ' ' + c : '') + '"' + (c ? ' role="alert"' : '') + '>' + t + '</p>'; }
  function opt(v, l, cur) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + esc(l) + '</option>'; }

  function chipsHtml() {
    var f = S.f, h = '<div class="bnx-chips" role="group" aria-label="التصنيفات">';
    function chip(v, l) { return '<button type="button" data-a="cat" data-v="' + v + '" class="' + (f.cat === v ? 'on' : '') + '">' + esc(l) + '</button>'; }
    h += chip('all', 'الكل') + chip('unread', 'غير المقروءة (' + unread() + ')') + chip('hot', 'المهمة والعاجلة');
    Object.keys(CATS).forEach(function (k) { h += chip(k, CATS[k]); });
    return h + '</div>';
  }
  function filtersHtml() {
    var f = S.f, h = '<div class="bnx-f"><input type="search" data-q aria-label="بحث في الإشعارات" placeholder="ابحث في الإشعارات" value="' + esc(f.q) + '" autocomplete="off">';
    h += '<details><summary>فلاتر</summary><div class="bnx-sel">';
    h += '<select data-f="type" aria-label="النوع">' + opt('', 'كل الأنواع', f.type) +
      Object.keys(TYPES).map(function (k) { return opt(k, TYPES[k].l, f.type); }).join('') + '</select>';
    h += '<select data-f="pr" aria-label="الأهمية">' + opt('', 'كل المستويات', f.pr) + opt('urgent', 'عاجل', f.pr) + opt('important', 'مهم', f.pr) + opt('normal', 'عادي', f.pr) + '</select>';
    h += '<select data-f="st" aria-label="الحالة">' + opt('', 'كل الحالات', f.st) + opt('unread', 'غير مقروء', f.st) + opt('read', 'مقروء', f.st) + '</select>';
    h += '<select data-f="dt" aria-label="التاريخ">' + opt('', 'كل التواريخ', f.dt) + opt('d1', 'آخر 24 ساعة', f.dt) + opt('d7', 'آخر 7 أيام', f.dt) + opt('d30', 'آخر 30 يوماً', f.dt) + '</select>';
    return h + '</div></details></div>';
  }
  function rowHtml(it) {
    var rd = isRead(it), p = prio(it);
    return '<div class="bnx-i' + (rd ? '' : ' un') + '">' +
      '<label class="bnx-ck"><input type="checkbox" data-a="sel" data-id="' + esc(it.id) + '" aria-label="تحديد الإشعار"' + (S.sel.has(it.id) ? ' checked' : '') + '></label>' +
      '<button type="button" class="bnx-m" data-a="open" data-id="' + esc(it.id) + '"><strong>' + esc(it.title || typeLabel(it)) + '</strong>' +
      (it.body ? '<span>' + esc(it.body) + '</span>' : '') +
      '<small><em class="bnx-pr ' + PC[p] + '">' + PR[p] + '</em>' + esc(typeLabel(it)) + (it.at ? ' · ' + esc(when(it.at)) : '') + '</small></button></div>';
  }
  function detailHtml(it) {
    var rd = isRead(it), p = prio(it);
    return '<div class="bnx-d"><button type="button" class="bnx-t" data-a="back">رجوع للقائمة</button>' +
      '<h3>' + esc(it.title || typeLabel(it)) + '</h3>' + (it.body ? '<p>' + esc(it.body) + '</p>' : '') +
      '<dl><dt>نوع الحدث</dt><dd>' + esc(typeLabel(it)) + '</dd><dt>الوقت</dt><dd>' + esc(when(it.at) || 'غير مسجّل') + '</dd>' +
      '<dt>العنصر المرتبط</dt><dd>' + esc(it.ref || 'غير محدد') + '</dd>' +
      '<dt>الأهمية</dt><dd><em class="bnx-pr ' + PC[p] + '">' + PR[p] + '</em></dd><dt>الحالة</dt><dd>' + (rd ? 'مقروء' : 'غير مقروء') + '</dd></dl>' +
      '<div class="bnx-ac">' + (it.link ? '<button type="button" class="bnx-b" data-a="go" data-l="' + esc(it.link) + '">فتح التفاصيل</button>' : '') +
      (rd ? '' : '<button type="button" class="bnx-b o" data-a="markone" data-id="' + esc(it.id) + '">تحديد كمقروء</button>') + '</div>' +
      (S.msg ? '<p class="bnx-n" role="alert">' + esc(S.msg) + '</p>' : '') +
      '<p class="bnx-n">القرار الإداري يتم من القسم المختص، وليس من هذا الإشعار.</p></div>';
  }
  function settingsHtml() {
    var h = '<div class="bnx-s"><h3>الإشعارات التي تظهر لي</h3>';
    Object.keys(TYPES).forEach(function (k) {
      h += '<label><input type="checkbox" data-a="toggle" data-id="' + k + '"' + (prefs.off[k] ? '' : ' checked') + '> ' + esc(TYPES[k].l) + '</label>';
    });
    h += '<label><input type="checkbox" data-a="hidenormal"' + (prefs.hideNormal ? ' checked' : '') + '> إخفاء الإشعارات العادية من العرض الرئيسي (لا تُحذف)</label>';
    h += '<h3>قنوات الإشعار</h3><p>داخل لوحة الإدارة: يعمل.</p>' +
      '<p>البريد الإلكتروني: غير مفعّل. يحتاج خدمة إرسال مهيّأة في الخلفية.</p>' +
      '<p>إشعارات المتصفح والهاتف: غير مفعّلة. لا تطلب هذه الوحدة أي إذن من المتصفح.</p>' +
      '<p class="bnx-n">هذه التفضيلات محفوظة على هذا الجهاز فقط.</p></div>';
    return h;
  }
  function shell(v) {
    var h = '<div class="bnx-h"><strong>الإشعارات</strong><button type="button" class="bnx-t" data-a="refresh">تحديث</button>' +
      '<button type="button" class="bnx-t" data-a="settings">' + (S.view === 'set' ? 'القائمة' : 'الإعدادات') + '</button>' +
      (v.page ? '' : '<button type="button" class="bnx-t" data-a="close" aria-label="إغلاق">✕</button>') + '</div>';
    var it = S.open && S.items.get(S.open);
    if (S.view === 'set') return h + settingsHtml();
    if (it) return h + detailHtml(it);
    return h + chipsHtml() + filtersHtml() + '<div class="bnx-l" data-r="list"></div>';
  }
  function paintList() {
    var rows = list(), h = '';
    if (S.status === 'nosrc') h = emp('لم يُربط مصدر بيانات بعد. عرّف source.load عند الاستدعاء.');
    else if (S.status === 'idle' || (S.status === 'loading' && !S.items.size)) h = emp('جارٍ تحميل الإشعارات…');
    else {
      if (S.status === 'err') h += emp('تعذّر تحميل الإشعارات، وقد تكون الأرقام قديمة.', 'er') +
        '<div class="bnx-ac"><button type="button" class="bnx-b o" data-a="refresh">إعادة المحاولة</button></div>';
      if (rows.length) {
        var un = rows.filter(function (i) { return !isRead(i); }).length;
        h += '<div class="bnx-bulk"><button type="button" class="bnx-t" data-a="marksel"' + (S.sel.size ? '' : ' disabled') + '>تحديد المحدد كمقروء</button>' +
          '<button type="button" class="bnx-t" data-a="markall"' + (un ? '' : ' disabled') + '>تحديد الكل كمقروء (' + un + ')</button></div>';
        h += rows.map(rowHtml).join('');
      } else if (S.status !== 'err') {
        h += emp(S.items.size ? 'لا توجد نتائج مطابقة للفلاتر.' : 'لا توجد إشعارات.');
      }
      if (S.hid) h += '<p class="bnx-n">' + S.hid + ' إشعار عادي مخفي من العرض الرئيسي (لم يُحذف).</p>';
    }
    if (S.msg) h += '<p class="bnx-n" role="alert">' + esc(S.msg) + '</p>';
    if (cfg.source && cfg.source.load && !cfg.source.markRead) h += '<p class="bnx-n">حالة القراءة محفوظة على هذا الجهاز فقط.</p>';
    views.forEach(function (v) { var el = v.root.querySelector('[data-r="list"]'); if (el) el.innerHTML = h; });
  }
  function badge() {
    var n = unread(), er = S.status === 'err';
    badgeEl.textContent = er ? '!' : (n > 99 ? '99+' : String(n));
    badgeEl.hidden = !er && (n === 0 || S.status === 'nosrc');
    badgeEl.classList.toggle('er', er);
    bell.setAttribute('aria-label', er ? 'الإشعارات: تعذّر التحميل' : 'الإشعارات، ' + n + ' غير مقروء');
  }
  function paint() {
    if (!cfg) return;
    views.forEach(function (v) { v.root.innerHTML = shell(v); });
    paintList(); badge();
  }

  /* ---------- التفاعل ---------- */
  function pos() {
    var b = bell.getBoundingClientRect(), pw = Math.min(430, w.innerWidth - 16);
    var l = Math.max(8, Math.min(b.left + b.width / 2 - pw / 2, w.innerWidth - pw - 8));
    dd.style.left = l + 'px'; dd.style.top = Math.max(8, b.bottom + 8) + 'px';
  }
  function openP() {
    pos(); dd.hidden = false; bell.setAttribute('aria-expanded', 'true');
    if (S.status === 'idle' || S.status === 'err') load();
    var f = dd.querySelector('button,input'); if (f) f.focus();
  }
  function closeP() { dd.hidden = true; bell.setAttribute('aria-expanded', 'false'); }

  function onClick(e) {
    var t = e.target.closest('[data-a]');
    if (!t) return;
    var a = t.getAttribute('data-a'), id = t.getAttribute('data-id');
    if (a === 'sel' || a === 'toggle' || a === 'hidenormal') return;       // تُعالج في change
    if (a === 'cat') { S.f.cat = t.getAttribute('data-v'); S.sel.clear(); paint(); }
    else if (a === 'open') {
      var it = S.items.get(id);
      if (!it) return;
      if (cfg.canOpen && cfg.canOpen(it.raw) === false) { S.msg = 'لا تملك صلاحية عرض تفاصيل هذا الإشعار.'; paintList(); return; }
      S.open = id; S.msg = ''; paint();
      if (cfg.markOnOpen !== false) markRead([id]);
    }
    else if (a === 'back') { S.open = null; paint(); }
    else if (a === 'settings') { S.view = S.view === 'set' ? 'list' : 'set'; S.open = null; paint(); }
    else if (a === 'refresh') load();
    else if (a === 'close') { closeP(); bell.focus(); }
    else if (a === 'markone') markRead([id]);
    else if (a === 'marksel') markRead(Array.from(S.sel));
    else if (a === 'markall') markRead(list().filter(function (i) { return !isRead(i); }).map(function (i) { return i.id; }));
    else if (a === 'go') { var l = safeLink(t.getAttribute('data-l')); closeP(); if (l) w.location.hash = l; }
  }
  function onChange(e) {
    var t = e.target, a = t.getAttribute('data-a'), fk = t.getAttribute('data-f');
    if (fk) { S.f[fk] = t.value; paintList(); return; }
    if (a === 'sel') { var id = t.getAttribute('data-id'); if (t.checked) S.sel.add(id); else S.sel.delete(id); paintList(); }
    else if (a === 'toggle') {
      var k = t.getAttribute('data-id'); if (t.checked) delete prefs.off[k]; else prefs.off[k] = true;
      sv('prefs', prefs); badge();
    }
    else if (a === 'hidenormal') { prefs.hideNormal = t.checked; sv('prefs', prefs); }
  }
  function onInput(e) { if (e.target.hasAttribute('data-q')) { S.f.q = e.target.value; paintList(); } }
  function attach(r) { r.addEventListener('click', onClick); r.addEventListener('change', onChange); r.addEventListener('input', onInput); }

  var CSS = '.bnx-v{direction:rtl;color:var(--ink,#0E1B2E);font:400 14px/1.6 var(--f,"Readex Pro","Segoe UI",Tahoma,sans-serif);background:#fff}' +
    '.bnx-v button,.bnx-v input,.bnx-v select{font:inherit}' +
    '.bnx-p{position:fixed;z-index:70;width:min(430px,calc(100vw - 16px));max-height:min(78vh,620px);display:flex;flex-direction:column;border:1px solid var(--line,#DCE3EB);border-radius:14px;box-shadow:0 18px 40px rgba(6,25,58,.28)}' +
    '.bnx-p[hidden]{display:none}.bnx-pg{border:1px solid var(--line,#DCE3EB);border-radius:14px;overflow:hidden}.bnx-pg .bnx-l{max-height:70vh}' +
    '.bnx-h{display:flex;align-items:center;gap:2px;padding:4px 14px;border-bottom:1px solid var(--line,#DCE3EB)}.bnx-h strong{flex:1;font-size:16px}' +
    '.bnx-t{background:none;border:0;color:var(--b,#1A4FA0);cursor:pointer;min-height:44px;padding:0 8px;font-size:13px}.bnx-t[disabled]{opacity:.4;cursor:default}' +
    '.bnx-chips{display:flex;gap:6px;overflow-x:auto;padding:8px 12px;border-bottom:1px solid var(--line,#DCE3EB)}' +
    '.bnx-chips button{flex:none;white-space:nowrap;border:1px solid var(--line,#DCE3EB);background:#fff;color:inherit;border-radius:99px;padding:6px 14px;min-height:40px;cursor:pointer}' +
    '.bnx-chips button.on{background:var(--nav,#06193A);border-color:var(--nav,#06193A);color:#fff}' +
    '.bnx-f{padding:8px 12px;border-bottom:1px solid var(--line,#DCE3EB)}' +
    '.bnx-f input[type=search],.bnx-sel select{width:100%;min-height:44px;font-size:16px;border:1px solid var(--line,#DCE3EB);border-radius:10px;padding:8px 12px;background:#fff;color:inherit;box-sizing:border-box}' +
    '.bnx-f summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--b,#1A4FA0)}.bnx-sel{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding-bottom:6px}' +
    '.bnx-l{overflow:auto;flex:1;overscroll-behavior:contain}.bnx-bulk{display:flex;justify-content:space-between;border-bottom:1px solid var(--line,#DCE3EB);padding:0 6px}' +
    '.bnx-i{display:flex;align-items:stretch;border-bottom:1px solid var(--line,#DCE3EB)}.bnx-i.un{background:#f4f8ff;border-inline-start:4px solid var(--b,#1A4FA0)}' +
    '.bnx-ck{width:44px;flex:none;display:grid;place-items:center}.bnx-ck input,.bnx-s input{width:22px;height:22px;margin:0}' +
    '.bnx-m{flex:1;min-width:0;text-align:start;background:none;border:0;color:inherit;padding:10px 4px;display:grid;gap:2px;cursor:pointer;min-height:44px}' +
    '.bnx-m span{color:var(--mut,#5B6879);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bnx-m small{color:var(--mut,#5B6879);font-size:12px}' +
    '.bnx-pr{font-style:normal;border-radius:99px;padding:0 8px;font-size:11px;margin-inline-end:6px}' +
    '.bnx-pu{background:#fde0dc;color:#a02a1c}.bnx-pi{background:#fff3d6;color:#7a5200}.bnx-pn{background:#edf1f5;color:#3f4d63}' +
    '.bnx-d,.bnx-s{padding:8px 14px 14px;overflow:auto}.bnx-d h3,.bnx-s h3{margin:12px 0 6px;font-size:16px}.bnx-d p,.bnx-s p{margin:6px 0}' +
    '.bnx-d dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:10px 0}.bnx-d dt{color:var(--mut,#5B6879)}.bnx-d dd{margin:0}' +
    '.bnx-s label{display:flex;align-items:center;gap:10px;min-height:44px}' +
    '.bnx-ac{display:flex;gap:8px;flex-wrap:wrap;padding:6px 14px}.bnx-d .bnx-ac{padding:6px 0}' +
    '.bnx-b{background:var(--b,#1A4FA0);color:#fff;border:1.5px solid var(--b,#1A4FA0);border-radius:10px;padding:8px 16px;min-height:44px;cursor:pointer}.bnx-b.o{background:#fff;color:var(--b,#1A4FA0)}' +
    '.bnx-e{margin:0;padding:18px 14px;text-align:center;color:var(--mut,#5B6879)}.bnx-e.er{color:#a02a1c}' +
    '.bnx-n{margin:0;padding:8px 14px;font-size:12px;color:var(--mut,#5B6879);background:#fff8e6;border-top:1px solid var(--line,#DCE3EB)}' +
    '.bnx-badge{position:absolute;top:-4px;inset-inline-start:-4px;min-width:20px;height:20px;border-radius:99px;background:#E0A81B;color:#06193A;font-size:11px;font-weight:600;line-height:1;display:grid;place-items:center;padding:0 5px}' +
    '.bnx-badge[hidden]{display:none}.bnx-badge.er{background:#a02a1c;color:#fff}' +
    '.bnx-v button:focus-visible,.bnx-v input:focus-visible,.bnx-v select:focus-visible,.bnx-v summary:focus-visible{outline:3px solid #E0A81B;outline-offset:-3px}';

  /* ---------- الواجهة العامة ---------- */
  function mount(o) {
    o = o || {};
    if (cfg) { console.warn('BahrNotify: مُركّبة مسبقاً'); return false; }
    if (o.canAccess && !o.canAccess()) return false;
    var el = o.bell && d.querySelector(o.bell);
    if (!el) { console.warn('BahrNotify: لم أجد زر الجرس', o.bell); return false; }
    var reserved = /^(bell|bc|nfp)$/;
    var bEl = o.badge ? d.querySelector(o.badge) : null;
    if ((reserved.test(el.id) || (bEl && reserved.test(bEl.id))) && !o.allowExisting) {
      console.warn('BahrNotify: #bell و#bc و#nfp تخص نظام B45. استعمل عنصراً بـ ID جديد.');
      return false;
    }
    cfg = o; bell = el;
    Object.keys(o.types || {}).forEach(function (k) { TYPES[k] = o.types[k]; });
    var p = ld('prefs', null); if (p && p.off) prefs = { off: p.off, hideNormal: !!p.hideNormal };
    localRead = new Set(ld('read', []));

    if (!d.getElementById('bnx-css')) { var st = d.createElement('style'); st.id = 'bnx-css'; st.textContent = CSS; d.head.appendChild(st); }
    if (w.getComputedStyle(bell).position === 'static') bell.style.position = 'relative';
    if (bEl) badgeEl = bEl; else { badgeEl = d.createElement('span'); bell.appendChild(badgeEl); }
    badgeEl.classList.add('bnx-badge'); badgeEl.hidden = true;

    dd = d.createElement('div'); dd.id = 'bnx-panel'; dd.className = 'bnx-p bnx-v'; dd.hidden = true;
    dd.setAttribute('role', 'dialog'); dd.setAttribute('aria-label', 'الإشعارات'); d.body.appendChild(dd);
    bell.setAttribute('aria-haspopup', 'dialog'); bell.setAttribute('aria-expanded', 'false'); bell.setAttribute('aria-controls', 'bnx-panel');
    attach(dd); views.push({ root: dd, page: false });

    bell.addEventListener('click', function (e) { e.preventDefault(); if (dd.hidden) openP(); else closeP(); });
    d.addEventListener('click', function (e) { if (!dd.hidden && !dd.contains(e.target) && !bell.contains(e.target)) closeP(); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !dd.hidden) { closeP(); bell.focus(); } });
    w.addEventListener('resize', function () { if (!dd.hidden) pos(); });
    if (o.refreshMs > 0) timer = w.setInterval(function () { if (!d.hidden) load(); }, o.refreshMs);

    paint(); load();
    return true;
  }
  function mountPage(sel) {
    var r = d.querySelector(sel);
    if (!cfg || !r) { console.warn('BahrNotify: استدعِ mount أولاً وتأكد من وجود العنصر', sel); return false; }
    r.classList.add('bnx-v', 'bnx-pg'); attach(r); views.push({ root: r, page: true }); paint();
    return true;
  }

  w.BahrNotify = { mount: mount, mountPage: mountPage, refresh: load, push: push, unread: unread };
})(window, document);
function bahrBoot() {
  BahrNotify.mount({ bell: '#admNtfBell' });
  if (BahrTeam.mount({ root: '#admTeamPage', trigger: '#admTeamBtn', hideWhileOpen: '#adm', autoCloseOn: ['#adn', '#adsub'] })) {
    document.getElementById('admTeamBtn').style.display = '';
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bahrBoot); else bahrBoot();
/* ===== ADM11 — BahrNotify: وحدة إشعارات مستقلة (الصقها كما هي في نهاية app.js) =====
   - مستقلة تماماً: تحقن تنسيقها بنفسها (بادئة bnx-) ولا تحتاج تعديل style.css.
   - لا تلمس نظام B45: ممنوع ربطها بـ #bell أو #bc أو #nfp (ترفض ذلك تلقائياً). أضف زرّاً جديداً بـ ID جديد.
   - لا تفترض اسم جدول ولا عميل Supabase: أنت تعرّف source.load وsource.map بنفسك.
   - لا تنشئ بيانات تجريبية: بدون source.load تعرض «لم يُربط مصدر بيانات» ولا تعرض شيئاً.
   - إخفاء الواجهة ليس حماية: الصلاحيات الفعلية تكون من RLS في الخلفية.

   مثال الربط (عدّل الأسماء لتطابق قاعدتك؛ لم أفحص جدولك):
   BahrNotify.mount({
     bell: '#admNtfBell',                 // ID زرّ جديد تضيفه في index.html
     canAccess: function () { return true; },     // اختياري، للواجهة فقط
     userKey: function () { return 'admin'; },    // مفتاح التخزين المحلي لكل مستخدم
     source: {
       load: async function () {
         var r = await YOUR_CLIENT.from('YOUR_TABLE').select('*').order('created_at', { ascending: false }).limit(200);
         if (r.error) throw r.error;
         return r.data;
       },
       map: function (r) { return { id: r.id, type: r.type, title: r.title, body: r.body,
         created_at: r.created_at, read: r.is_read, link: r.link, ref: r.ref_label, severity: r.severity }; },
       markRead: async function (ids) { / * حدّث الصفوف في الخلفية، وارمِ خطأً إن فشل * / }   // اختياري
     }
   });
   BahrNotify.mountPage('#admNtfPage');   // اختياري: عرض الصفحة الكاملة داخل عنصر موجود
   BahrNotify.push(rows);                 // اختياري: من آلية التحديث المباشر الموجودة عندك
*/
(function (w, d) {
  'use strict';
  if (w.BahrNotify) return;

  var PR = { urgent: 'عاجل', important: 'مهم', normal: 'عادي' };
  var PC = { urgent: 'bnx-pu', important: 'bnx-pi', normal: 'bnx-pn' };
  var CATS = { ads: 'الإعلانات', users: 'المستخدمون والتجّار', reports: 'البلاغات والمراجعة',
    orders: 'الطلبات والخدمات', chats: 'المحادثات والاستفسارات', system: 'النظام والأخطاء' };
  var DAYS = { d1: 1, d7: 7, d30: 30 };

  /* قواعد الأولوية صريحة: p = أولوية ثابتة أو دالة تقرأ الحقول. غير ذلك = عادي.
     أسماء type هنا مفاتيح فقط: لا يظهر إشعار إلا إذا أرسل مصدرك صفاً بهذا النوع فعلاً.
     عدّل أو أضف أنواعاً عبر mount({ types: { my_type: { l: 'الاسم', c: 'ads', p: 'normal' } } }). */
  var TYPES = {
    listing_review: { l: 'إعلان يحتاج مراجعة', c: 'ads', p: 'important' },
    verification_request: { l: 'طلب توثيق', c: 'users', p: 'important' },
    report: { l: 'بلاغ أو شكوى', c: 'reports', p: 'important' },
    inquiry: { l: 'استفسار أو رسالة للإدارة', c: 'chats', p: 'normal' },
    order_status: { l: 'تغيّر حالة طلب خدمة', c: 'orders', p: 'normal' },
    campaign_ending: { l: 'اقتراب انتهاء حملة', c: 'ads', p: 'normal' },
    campaign_ended: { l: 'انتهاء حملة', c: 'ads', p: 'normal' },
    tech_error: { l: 'خطأ تقني مسجّل', c: 'system', p: function (it) { return it.sev === 'critical' ? 'urgent' : 'important'; } },
    setting_change: { l: 'تغيير في إعدادات المنصة', c: 'system', p: 'important' },
    admin_review: { l: 'عملية إدارية تحتاج مراجعة', c: 'reports', p: 'important' }
  };

  var cfg = null, bell = null, badgeEl = null, dd = null, busy = false, timer = 0;
  var views = [], prefs = { off: {}, hideNormal: false }, localRead = new Set();
  var S = { items: new Map(), status: 'idle', f: { cat: 'all', q: '', type: '', pr: '', st: '', dt: '' },
    sel: new Set(), open: null, view: 'list', msg: '', hid: 0 };

  /* ---------- أدوات ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeLink(l) { return typeof l === 'string' && /^#[A-Za-z0-9_\-\/.=&?%]*$/.test(l) ? l : ''; }
  function when(s) {
    var t = Date.parse(s);
    if (isNaN(t)) return '';
    try { return new Date(t).toLocaleString('ar-IQ', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return new Date(t).toLocaleString(); }
  }
  function key(n) {
    var u = 'anon';
    try { if (cfg && cfg.userKey) u = String(cfg.userKey()); } catch (e) {}
    return 'bnx:' + u + ':' + n;
  }
  function ld(n, def) { try { var v = w.localStorage.getItem(key(n)); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function sv(n, v) { try { w.localStorage.setItem(key(n), JSON.stringify(v)); return true; } catch (e) { return false; } }

  /* ---------- البيانات ---------- */
  function norm(r) {
    var m = cfg.source && cfg.source.map ? cfg.source.map(r) : r;
    if (!m || m.id == null) return null;
    return { id: String(m.id), type: m.type || '', title: m.title || '', body: m.body || '',
      at: m.created_at || m.at || '', read: !!(m.read || m.read_at), pr: m.priority,
      link: safeLink(m.link), ref: m.ref || '', sev: m.severity, raw: r };
  }
  function isRead(it) { return it.read || localRead.has(it.id); }
  function prio(it) {
    var t = TYPES[it.type], r = t ? t.p : null;
    if (typeof r === 'function') r = r(it);
    if (!PR[r]) r = PR[it.pr] ? it.pr : 'normal';
    return r;
  }
  function cat(it) { return (TYPES[it.type] && TYPES[it.type].c) || 'other'; }
  function typeLabel(it) { return (TYPES[it.type] && TYPES[it.type].l) || it.type || 'حدث'; }
  function unread() {
    var n = 0;
    S.items.forEach(function (it) { if (!prefs.off[it.type] && !isRead(it)) n++; });
    return n;
  }
  function list() {
    var f = S.f, out = [], now = Date.now(), q = f.q.toLowerCase();
    S.hid = 0;
    S.items.forEach(function (it) {
      if (prefs.off[it.type]) return;
      var rd = isRead(it), p = prio(it), c = cat(it);
      if (f.cat === 'unread' && rd) return;
      if (f.cat === 'hot' && p === 'normal') return;
      if (CATS[f.cat] && c !== f.cat) return;
      if (f.type && it.type !== f.type) return;
      if (f.pr && p !== f.pr) return;
      if (f.st === 'unread' && rd) return;
      if (f.st === 'read' && !rd) return;
      if (f.dt) { var t = Date.parse(it.at); if (isNaN(t) || now - t > DAYS[f.dt] * 864e5) return; }
      if (q && (it.title + ' ' + it.body + ' ' + it.ref + ' ' + typeLabel(it)).toLowerCase().indexOf(q) < 0) return;
      if (prefs.hideNormal && f.cat === 'all' && !f.pr && p === 'normal') { S.hid++; return; }
      out.push(it);
    });
    out.sort(function (a, b) { return (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0); });
    return out;
  }

  function load() {
    if (!cfg) return Promise.resolve();
    if (!cfg.source || typeof cfg.source.load !== 'function') { S.status = 'nosrc'; paint(); return Promise.resolve(); }
    if (busy) return Promise.resolve();
    busy = true; S.status = 'loading'; paint();
    return Promise.resolve().then(function () { return cfg.source.load(); }).then(function (rows) {
      var next = new Map();            // المفتاح = id، لذلك لا يتكرر الإشعار عند إعادة التحميل
      (rows || []).forEach(function (r) { var it = norm(r); if (it) next.set(it.id, it); });
      S.items = next; S.status = 'ok';
    }).catch(function () { S.status = 'err'; }).then(function () { busy = false; paint(); });
  }
  function push(rows) {
    if (!cfg) return;
    (rows || []).forEach(function (r) { var it = norm(r); if (it) S.items.set(it.id, it); });
    if (S.status !== 'err') S.status = 'ok';
    paint();
  }
  function markRead(ids) {
    ids = ids.filter(function (i) { var it = S.items.get(i); return it && !isRead(it); });
    if (!ids.length) return Promise.resolve();
    var src = cfg.source, p;
    if (src && typeof src.markRead === 'function') {
      p = Promise.resolve().then(function () { return src.markRead(ids); })
        .then(function () { ids.forEach(function (i) { S.items.get(i).read = true; }); });
    } else {
      p = Promise.resolve().then(function () {
        ids.forEach(function (i) { localRead.add(i); });
        if (!sv('read', Array.from(localRead))) { ids.forEach(function (i) { localRead.delete(i); }); throw new Error('local'); }
      });
    }
    return p.then(function () { S.msg = ''; }, function () { S.msg = 'تعذّر تحديث حالة القراءة، ولم يتغيّر شيء.'; })
      .then(function () { S.sel.clear(); paint(); });
  }

  /* ---------- العرض ---------- */
  function emp(t, c) { return '<p class="bnx-e' + (c ? ' ' + c : '') + '"' + (c ? ' role="alert"' : '') + '>' + t + '</p>'; }
  function opt(v, l, cur) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + esc(l) + '</option>'; }

  function chipsHtml() {
    var f = S.f, h = '<div class="bnx-chips" role="group" aria-label="التصنيفات">';
    function chip(v, l) { return '<button type="button" data-a="cat" data-v="' + v + '" class="' + (f.cat === v ? 'on' : '') + '">' + esc(l) + '</button>'; }
    h += chip('all', 'الكل') + chip('unread', 'غير المقروءة (' + unread() + ')') + chip('hot', 'المهمة والعاجلة');
    Object.keys(CATS).forEach(function (k) { h += chip(k, CATS[k]); });
    return h + '</div>';
  }
  function filtersHtml() {
    var f = S.f, h = '<div class="bnx-f"><input type="search" data-q aria-label="بحث في الإشعارات" placeholder="ابحث في الإشعارات" value="' + esc(f.q) + '" autocomplete="off">';
    h += '<details><summary>فلاتر</summary><div class="bnx-sel">';
    h += '<select data-f="type" aria-label="النوع">' + opt('', 'كل الأنواع', f.type) +
      Object.keys(TYPES).map(function (k) { return opt(k, TYPES[k].l, f.type); }).join('') + '</select>';
    h += '<select data-f="pr" aria-label="الأهمية">' + opt('', 'كل المستويات', f.pr) + opt('urgent', 'عاجل', f.pr) + opt('important', 'مهم', f.pr) + opt('normal', 'عادي', f.pr) + '</select>';
    h += '<select data-f="st" aria-label="الحالة">' + opt('', 'كل الحالات', f.st) + opt('unread', 'غير مقروء', f.st) + opt('read', 'مقروء', f.st) + '</select>';
    h += '<select data-f="dt" aria-label="التاريخ">' + opt('', 'كل التواريخ', f.dt) + opt('d1', 'آخر 24 ساعة', f.dt) + opt('d7', 'آخر 7 أيام', f.dt) + opt('d30', 'آخر 30 يوماً', f.dt) + '</select>';
    return h + '</div></details></div>';
  }
  function rowHtml(it) {
    var rd = isRead(it), p = prio(it);
    return '<div class="bnx-i' + (rd ? '' : ' un') + '">' +
      '<label class="bnx-ck"><input type="checkbox" data-a="sel" data-id="' + esc(it.id) + '" aria-label="تحديد الإشعار"' + (S.sel.has(it.id) ? ' checked' : '') + '></label>' +
      '<button type="button" class="bnx-m" data-a="open" data-id="' + esc(it.id) + '"><strong>' + esc(it.title || typeLabel(it)) + '</strong>' +
      (it.body ? '<span>' + esc(it.body) + '</span>' : '') +
      '<small><em class="bnx-pr ' + PC[p] + '">' + PR[p] + '</em>' + esc(typeLabel(it)) + (it.at ? ' · ' + esc(when(it.at)) : '') + '</small></button></div>';
  }
  function detailHtml(it) {
    var rd = isRead(it), p = prio(it);
    return '<div class="bnx-d"><button type="button" class="bnx-t" data-a="back">رجوع للقائمة</button>' +
      '<h3>' + esc(it.title || typeLabel(it)) + '</h3>' + (it.body ? '<p>' + esc(it.body) + '</p>' : '') +
      '<dl><dt>نوع الحدث</dt><dd>' + esc(typeLabel(it)) + '</dd><dt>الوقت</dt><dd>' + esc(when(it.at) || 'غير مسجّل') + '</dd>' +
      '<dt>العنصر المرتبط</dt><dd>' + esc(it.ref || 'غير محدد') + '</dd>' +
      '<dt>الأهمية</dt><dd><em class="bnx-pr ' + PC[p] + '">' + PR[p] + '</em></dd><dt>الحالة</dt><dd>' + (rd ? 'مقروء' : 'غير مقروء') + '</dd></dl>' +
      '<div class="bnx-ac">' + (it.link ? '<button type="button" class="bnx-b" data-a="go" data-l="' + esc(it.link) + '">فتح التفاصيل</button>' : '') +
      (rd ? '' : '<button type="button" class="bnx-b o" data-a="markone" data-id="' + esc(it.id) + '">تحديد كمقروء</button>') + '</div>' +
      (S.msg ? '<p class="bnx-n" role="alert">' + esc(S.msg) + '</p>' : '') +
      '<p class="bnx-n">القرار الإداري يتم من القسم المختص، وليس من هذا الإشعار.</p></div>';
  }
  function settingsHtml() {
    var h = '<div class="bnx-s"><h3>الإشعارات التي تظهر لي</h3>';
    Object.keys(TYPES).forEach(function (k) {
      h += '<label><input type="checkbox" data-a="toggle" data-id="' + k + '"' + (prefs.off[k] ? '' : ' checked') + '> ' + esc(TYPES[k].l) + '</label>';
    });
    h += '<label><input type="checkbox" data-a="hidenormal"' + (prefs.hideNormal ? ' checked' : '') + '> إخفاء الإشعارات العادية من العرض الرئيسي (لا تُحذف)</label>';
    h += '<h3>قنوات الإشعار</h3><p>داخل لوحة الإدارة: يعمل.</p>' +
      '<p>البريد الإلكتروني: غير مفعّل. يحتاج خدمة إرسال مهيّأة في الخلفية.</p>' +
      '<p>إشعارات المتصفح والهاتف: غير مفعّلة. لا تطلب هذه الوحدة أي إذن من المتصفح.</p>' +
      '<p class="bnx-n">هذه التفضيلات محفوظة على هذا الجهاز فقط.</p></div>';
    return h;
  }
  function shell(v) {
    var h = '<div class="bnx-h"><strong>الإشعارات</strong><button type="button" class="bnx-t" data-a="refresh">تحديث</button>' +
      '<button type="button" class="bnx-t" data-a="settings">' + (S.view === 'set' ? 'القائمة' : 'الإعدادات') + '</button>' +
      (v.page ? '' : '<button type="button" class="bnx-t" data-a="close" aria-label="إغلاق">✕</button>') + '</div>';
    var it = S.open && S.items.get(S.open);
    if (S.view === 'set') return h + settingsHtml();
    if (it) return h + detailHtml(it);
    return h + chipsHtml() + filtersHtml() + '<div class="bnx-l" data-r="list"></div>';
  }
  function paintList() {
    var rows = list(), h = '';
    if (S.status === 'nosrc') h = emp('لم يُربط مصدر بيانات بعد. عرّف source.load عند الاستدعاء.');
    else if (S.status === 'idle' || (S.status === 'loading' && !S.items.size)) h = emp('جارٍ تحميل الإشعارات…');
    else {
      if (S.status === 'err') h += emp('تعذّر تحميل الإشعارات، وقد تكون الأرقام قديمة.', 'er') +
        '<div class="bnx-ac"><button type="button" class="bnx-b o" data-a="refresh">إعادة المحاولة</button></div>';
      if (rows.length) {
        var un = rows.filter(function (i) { return !isRead(i); }).length;
        h += '<div class="bnx-bulk"><button type="button" class="bnx-t" data-a="marksel"' + (S.sel.size ? '' : ' disabled') + '>تحديد المحدد كمقروء</button>' +
          '<button type="button" class="bnx-t" data-a="markall"' + (un ? '' : ' disabled') + '>تحديد الكل كمقروء (' + un + ')</button></div>';
        h += rows.map(rowHtml).join('');
      } else if (S.status !== 'err') {
        h += emp(S.items.size ? 'لا توجد نتائج مطابقة للفلاتر.' : 'لا توجد إشعارات.');
      }
      if (S.hid) h += '<p class="bnx-n">' + S.hid + ' إشعار عادي مخفي من العرض الرئيسي (لم يُحذف).</p>';
    }
    if (S.msg) h += '<p class="bnx-n" role="alert">' + esc(S.msg) + '</p>';
    if (cfg.source && cfg.source.load && !cfg.source.markRead) h += '<p class="bnx-n">حالة القراءة محفوظة على هذا الجهاز فقط.</p>';
    views.forEach(function (v) { var el = v.root.querySelector('[data-r="list"]'); if (el) el.innerHTML = h; });
  }
  function badge() {
    var n = unread(), er = S.status === 'err';
    badgeEl.textContent = er ? '!' : (n > 99 ? '99+' : String(n));
    badgeEl.hidden = !er && (n === 0 || S.status === 'nosrc');
    badgeEl.classList.toggle('er', er);
    bell.setAttribute('aria-label', er ? 'الإشعارات: تعذّر التحميل' : 'الإشعارات، ' + n + ' غير مقروء');
  }
  function paint() {
    if (!cfg) return;
    views.forEach(function (v) { v.root.innerHTML = shell(v); });
    paintList(); badge();
  }

  /* ---------- التفاعل ---------- */
  function pos() {
    var b = bell.getBoundingClientRect(), pw = Math.min(430, w.innerWidth - 16);
    var l = Math.max(8, Math.min(b.left + b.width / 2 - pw / 2, w.innerWidth - pw - 8));
    dd.style.left = l + 'px'; dd.style.top = Math.max(8, b.bottom + 8) + 'px';
  }
  function openP() {
    pos(); dd.hidden = false; bell.setAttribute('aria-expanded', 'true');
    if (S.status === 'idle' || S.status === 'err') load();
    var f = dd.querySelector('button,input'); if (f) f.focus();
  }
  function closeP() { dd.hidden = true; bell.setAttribute('aria-expanded', 'false'); }

  function onClick(e) {
    var t = e.target.closest('[data-a]');
    if (!t) return;
    var a = t.getAttribute('data-a'), id = t.getAttribute('data-id');
    if (a === 'sel' || a === 'toggle' || a === 'hidenormal') return;       // تُعالج في change
    if (a === 'cat') { S.f.cat = t.getAttribute('data-v'); S.sel.clear(); paint(); }
    else if (a === 'open') {
      var it = S.items.get(id);
      if (!it) return;
      if (cfg.canOpen && cfg.canOpen(it.raw) === false) { S.msg = 'لا تملك صلاحية عرض تفاصيل هذا الإشعار.'; paintList(); return; }
      S.open = id; S.msg = ''; paint();
      if (cfg.markOnOpen !== false) markRead([id]);
    }
    else if (a === 'back') { S.open = null; paint(); }
    else if (a === 'settings') { S.view = S.view === 'set' ? 'list' : 'set'; S.open = null; paint(); }
    else if (a === 'refresh') load();
    else if (a === 'close') { closeP(); bell.focus(); }
    else if (a === 'markone') markRead([id]);
    else if (a === 'marksel') markRead(Array.from(S.sel));
    else if (a === 'markall') markRead(list().filter(function (i) { return !isRead(i); }).map(function (i) { return i.id; }));
    else if (a === 'go') { var l = safeLink(t.getAttribute('data-l')); closeP(); if (l) w.location.hash = l; }
  }
  function onChange(e) {
    var t = e.target, a = t.getAttribute('data-a'), fk = t.getAttribute('data-f');
    if (fk) { S.f[fk] = t.value; paintList(); return; }
    if (a === 'sel') { var id = t.getAttribute('data-id'); if (t.checked) S.sel.add(id); else S.sel.delete(id); paintList(); }
    else if (a === 'toggle') {
      var k = t.getAttribute('data-id'); if (t.checked) delete prefs.off[k]; else prefs.off[k] = true;
      sv('prefs', prefs); badge();
    }
    else if (a === 'hidenormal') { prefs.hideNormal = t.checked; sv('prefs', prefs); }
  }
  function onInput(e) { if (e.target.hasAttribute('data-q')) { S.f.q = e.target.value; paintList(); } }
  function attach(r) { r.addEventListener('click', onClick); r.addEventListener('change', onChange); r.addEventListener('input', onInput); }

  var CSS = '.bnx-v{direction:rtl;color:var(--ink,#0E1B2E);font:400 14px/1.6 var(--f,"Readex Pro","Segoe UI",Tahoma,sans-serif);background:#fff}' +
    '.bnx-v button,.bnx-v input,.bnx-v select{font:inherit}' +
    '.bnx-p{position:fixed;z-index:70;width:min(430px,calc(100vw - 16px));max-height:min(78vh,620px);display:flex;flex-direction:column;border:1px solid var(--line,#DCE3EB);border-radius:14px;box-shadow:0 18px 40px rgba(6,25,58,.28)}' +
    '.bnx-p[hidden]{display:none}.bnx-pg{border:1px solid var(--line,#DCE3EB);border-radius:14px;overflow:hidden}.bnx-pg .bnx-l{max-height:70vh}' +
    '.bnx-h{display:flex;align-items:center;gap:2px;padding:4px 14px;border-bottom:1px solid var(--line,#DCE3EB)}.bnx-h strong{flex:1;font-size:16px}' +
    '.bnx-t{background:none;border:0;color:var(--b,#1A4FA0);cursor:pointer;min-height:44px;padding:0 8px;font-size:13px}.bnx-t[disabled]{opacity:.4;cursor:default}' +
    '.bnx-chips{display:flex;gap:6px;overflow-x:auto;padding:8px 12px;border-bottom:1px solid var(--line,#DCE3EB)}' +
    '.bnx-chips button{flex:none;white-space:nowrap;border:1px solid var(--line,#DCE3EB);background:#fff;color:inherit;border-radius:99px;padding:6px 14px;min-height:40px;cursor:pointer}' +
    '.bnx-chips button.on{background:var(--nav,#06193A);border-color:var(--nav,#06193A);color:#fff}' +
    '.bnx-f{padding:8px 12px;border-bottom:1px solid var(--line,#DCE3EB)}' +
    '.bnx-f input[type=search],.bnx-sel select{width:100%;min-height:44px;font-size:16px;border:1px solid var(--line,#DCE3EB);border-radius:10px;padding:8px 12px;background:#fff;color:inherit;box-sizing:border-box}' +
    '.bnx-f summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--b,#1A4FA0)}.bnx-sel{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding-bottom:6px}' +
    '.bnx-l{overflow:auto;flex:1;overscroll-behavior:contain}.bnx-bulk{display:flex;justify-content:space-between;border-bottom:1px solid var(--line,#DCE3EB);padding:0 6px}' +
    '.bnx-i{display:flex;align-items:stretch;border-bottom:1px solid var(--line,#DCE3EB)}.bnx-i.un{background:#f4f8ff;border-inline-start:4px solid var(--b,#1A4FA0)}' +
    '.bnx-ck{width:44px;flex:none;display:grid;place-items:center}.bnx-ck input,.bnx-s input{width:22px;height:22px;margin:0}' +
    '.bnx-m{flex:1;min-width:0;text-align:start;background:none;border:0;color:inherit;padding:10px 4px;display:grid;gap:2px;cursor:pointer;min-height:44px}' +
    '.bnx-m span{color:var(--mut,#5B6879);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bnx-m small{color:var(--mut,#5B6879);font-size:12px}' +
    '.bnx-pr{font-style:normal;border-radius:99px;padding:0 8px;font-size:11px;margin-inline-end:6px}' +
    '.bnx-pu{background:#fde0dc;color:#a02a1c}.bnx-pi{background:#fff3d6;color:#7a5200}.bnx-pn{background:#edf1f5;color:#3f4d63}' +
    '.bnx-d,.bnx-s{padding:8px 14px 14px;overflow:auto}.bnx-d h3,.bnx-s h3{margin:12px 0 6px;font-size:16px}.bnx-d p,.bnx-s p{margin:6px 0}' +
    '.bnx-d dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:10px 0}.bnx-d dt{color:var(--mut,#5B6879)}.bnx-d dd{margin:0}' +
    '.bnx-s label{display:flex;align-items:center;gap:10px;min-height:44px}' +
    '.bnx-ac{display:flex;gap:8px;flex-wrap:wrap;padding:6px 14px}.bnx-d .bnx-ac{padding:6px 0}' +
    '.bnx-b{background:var(--b,#1A4FA0);color:#fff;border:1.5px solid var(--b,#1A4FA0);border-radius:10px;padding:8px 16px;min-height:44px;cursor:pointer}.bnx-b.o{background:#fff;color:var(--b,#1A4FA0)}' +
    '.bnx-e{margin:0;padding:18px 14px;text-align:center;color:var(--mut,#5B6879)}.bnx-e.er{color:#a02a1c}' +
    '.bnx-n{margin:0;padding:8px 14px;font-size:12px;color:var(--mut,#5B6879);background:#fff8e6;border-top:1px solid var(--line,#DCE3EB)}' +
    '.bnx-badge{position:absolute;top:-4px;inset-inline-start:-4px;min-width:20px;height:20px;border-radius:99px;background:#E0A81B;color:#06193A;font-size:11px;font-weight:600;line-height:1;display:grid;place-items:center;padding:0 5px}' +
    '.bnx-badge[hidden]{display:none}.bnx-badge.er{background:#a02a1c;color:#fff}' +
    '.bnx-v button:focus-visible,.bnx-v input:focus-visible,.bnx-v select:focus-visible,.bnx-v summary:focus-visible{outline:3px solid #E0A81B;outline-offset:-3px}';

  /* ---------- الواجهة العامة ---------- */
  function mount(o) {
    o = o || {};
    if (cfg) { console.warn('BahrNotify: مُركّبة مسبقاً'); return false; }
    if (o.canAccess && !o.canAccess()) return false;
    var el = o.bell && d.querySelector(o.bell);
    if (!el) { console.warn('BahrNotify: لم أجد زر الجرس', o.bell); return false; }
    var reserved = /^(bell|bc|nfp)$/;
    var bEl = o.badge ? d.querySelector(o.badge) : null;
    if ((reserved.test(el.id) || (bEl && reserved.test(bEl.id))) && !o.allowExisting) {
      console.warn('BahrNotify: #bell و#bc و#nfp تخص نظام B45. استعمل عنصراً بـ ID جديد.');
      return false;
    }
    cfg = o; bell = el;
    Object.keys(o.types || {}).forEach(function (k) { TYPES[k] = o.types[k]; });
    var p = ld('prefs', null); if (p && p.off) prefs = { off: p.off, hideNormal: !!p.hideNormal };
    localRead = new Set(ld('read', []));

    if (!d.getElementById('bnx-css')) { var st = d.createElement('style'); st.id = 'bnx-css'; st.textContent = CSS; d.head.appendChild(st); }
    if (w.getComputedStyle(bell).position === 'static') bell.style.position = 'relative';
    if (bEl) badgeEl = bEl; else { badgeEl = d.createElement('span'); bell.appendChild(badgeEl); }
    badgeEl.classList.add('bnx-badge'); badgeEl.hidden = true;

    dd = d.createElement('div'); dd.id = 'bnx-panel'; dd.className = 'bnx-p bnx-v'; dd.hidden = true;
    dd.setAttribute('role', 'dialog'); dd.setAttribute('aria-label', 'الإشعارات'); d.body.appendChild(dd);
    bell.setAttribute('aria-haspopup', 'dialog'); bell.setAttribute('aria-expanded', 'false'); bell.setAttribute('aria-controls', 'bnx-panel');
    attach(dd); views.push({ root: dd, page: false });

    bell.addEventListener('click', function (e) { e.preventDefault(); if (dd.hidden) openP(); else closeP(); });
    d.addEventListener('click', function (e) { if (!dd.hidden && !dd.contains(e.target) && !bell.contains(e.target)) closeP(); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !dd.hidden) { closeP(); bell.focus(); } });
    w.addEventListener('resize', function () { if (!dd.hidden) pos(); });
    if (o.refreshMs > 0) timer = w.setInterval(function () { if (!d.hidden) load(); }, o.refreshMs);

    paint(); load();
    return true;
  }
  function mountPage(sel) {
    var r = d.querySelector(sel);
    if (!cfg || !r) { console.warn('BahrNotify: استدعِ mount أولاً وتأكد من وجود العنصر', sel); return false; }
    r.classList.add('bnx-v', 'bnx-pg'); attach(r); views.push({ root: r, page: true }); paint();
    return true;
  }

  w.BahrNotify = { mount: mount, mountPage: mountPage, refresh: load, push: push, unread: unread };
})(window, document);
/* ===== ADM12 — BahrTeam: مركز فريق الإدارة والصلاحيات (وحدة مستقلة، الصقها كما هي في نهاية app.js) =====
   - لا تستبدل تبويب «الأدوار الإدارية» (data-t="set") ولا سجل النشاط (audit): تعمل بجانبهما وتقرأ منهما عبر source.
   - لا تعرف اسم جدول ولا RPC عندك: كل قراءة وكتابة تمرّ عبر دوال source التي تعرّفها أنت.
   - بلا بيانات تجريبية ولا أعضاء وهميين. بلا حقول كلمات مرور إطلاقاً.
   - الواجهة للقراءة فقط ما لم تعرّف canManage وتُرجع true. وإخفاء الأزرار ليس حماية:
     يجب أن تتحقق دوال الخلفية (RPC/RLS) من أن المنفّذ مدير عام، وأن تكتب سجل التدقيق من الخادم.
   - أي دالة لم تعرّفها في source تظهر في الواجهة كـ«غير متاح: يحتاج تطويراً خلفياً».

   مثال الربط (الأسماء افتراضية؛ عدّلها لتطابق مشروعك):
   BahrTeam.mount({
     root: '#admTeamPage',                 // عنصر فارغ تضعه في index.html قرب #adm
     trigger: '#admTeamBtn',               // اختياري: زرّ جديد يفتح الصفحة
     hideWhileOpen: '#adm',                // اختياري: يُخفى أثناء فتح الصفحة
     autoCloseOn: ['#adn', '#adsub'],      // اختياري: تُغلق عند الضغط على أي تبويب آخر
     canAccess: function () { return true; },          // للواجهة فقط
     me: function () { return CURRENT_USER_ID; },      // لمنع تعديل الشخص لنفسه
     superRole: 'ROLE_ID_OF_GENERAL_MANAGER',          // معرّف دور المدير العام (أو دالة تستقبل العضو)
     source: {
       canManage: async function () { return false; }, // true فقط لمن تتحقق الخلفية من صلاحيته
       members: async function () { return []; },      // أعضاء الفريق الإداري فقط (لا المستخدمون العاديون): [{ id, name, email, avatar, role, status, sections, added_at, last_activity }]
       roles: async function () { return []; },        // [{ id, label, desc, super, sections, perms: { view:'view', edit:'act', ... } }]
       audit: async function (q) { return []; },       // q = { memberId?, limit } → [{ at, actor, action, target, result }]
       searchAccounts: async function (text) { return []; },  // [{ id, name, email }] المسموح تعيينهم فقط
       addMember: async function (p) {},      // p = { accountId, roleId }
       invite: async function (p) {},         // p = { email, roleId } — فقط إن وُجدت آلية دعوات فعلية
       setRole: async function (memberId, roleId) {},
       setStatus: async function (memberId, status) {}  // status = 'active' | 'suspended'
     }
   });
*/
(function (w, d) {
  'use strict';
  if (w.BahrTeam) return;

  var ROLES0 = [
    { id: 'general_manager', label: 'المدير العام', desc: 'إدارة المنصة والصلاحيات الحساسة' },
    { id: 'ads_manager', label: 'مدير الإعلانات', desc: 'مراجعة الإعلانات وإدارتها' },
    { id: 'trust_officer', label: 'مسؤول الثقة والتوثيق', desc: 'مراجعة طلبات التوثيق والبلاغات' },
    { id: 'support_officer', label: 'مسؤول خدمة العملاء', desc: 'متابعة الاستفسارات والشكاوى والمحادثات المصرح بها' },
    { id: 'marketing_officer', label: 'مسؤول التسويق', desc: 'إدارة الحملات ومتابعة تحليلات التسويق' },
    { id: 'finance_officer', label: 'المسؤول المالي', desc: 'الاطلاع على التقارير المالية وإدارة المهام المالية المصرح بها' },
    { id: 'tech_officer', label: 'مسؤول النظام التقني', desc: 'متابعة صحة الخدمات والأخطاء وإعدادات النظام المسموح بها' },
    { id: 'observer', label: 'مراقب', desc: 'الاطلاع على الأقسام المسموح بها دون تنفيذ إجراءات تعديل' }
  ];
  var PERMS = [['view', 'مشاهدة البيانات'], ['create', 'إنشاء السجلات'], ['edit', 'تعديل البيانات'], ['delete', 'حذف البيانات'],
    ['ads_review', 'قبول الإعلانات أو رفضها'], ['verification', 'إدارة طلبات التوثيق'], ['customer_data', 'الاطلاع على بيانات العملاء'],
    ['finance_reports', 'الاطلاع على التقارير المالية'], ['campaigns', 'إدارة الحملات'], ['platform_settings', 'تعديل إعدادات المنصة'],
    ['team_manage', 'إدارة أعضاء الفريق وصلاحياتهم']];
  var ST = { active: 'نشط', suspended: 'معلّق', pending: 'بانتظار القبول', other: 'غير محدد' };

  var cfg = null, root = null, hid = null;
  var S = { ml: [], roles: [], real: false, manage: false, status: 'idle', v: 'list', id: null,
    f: { q: '', role: '', st: '' }, dlg: null, msg: null, audit: null, aud: {} };

  /* ---------- أدوات ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function when(s) {
    var t = Date.parse(s);
    if (isNaN(t)) return '';
    try { return new Date(t).toLocaleString('ar-IQ', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return new Date(t).toLocaleString(); }
  }
  function fn(n) { return cfg && cfg.source && typeof cfg.source[n] === 'function'; }
  function call(n, a) { return Promise.resolve().then(function () { return cfg.source[n](a); }); }
  function avatar(m) {
    if (m.avatar && /^(https:\/\/|\/)/.test(m.avatar)) return '<img class="btm-av" src="' + esc(m.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
    return '<span class="btm-av">' + esc((m.name || m.email || '؟').trim().charAt(0)) + '</span>';
  }
  function stKey(m) {
    var s = String(m.status == null ? '' : m.status).toLowerCase();
    if (cfg.statusMap && cfg.statusMap[s]) return cfg.statusMap[s];
    if (/^(active|enabled|نشط)$/.test(s)) return 'active';
    if (/^(suspended|disabled|banned|معلق|معلّق)$/.test(s)) return 'suspended';
    if (/^(pending|invited)$/.test(s)) return 'pending';
    return 'other';
  }
  function role(id) { for (var i = 0; i < S.roles.length; i++) if (S.roles[i].id === String(id)) return S.roles[i]; return null; }
  function roleName(m) { var r = role(m.role); return r ? r.label : (m.role ? String(m.role) : 'غير محدد'); }
  function isSuper(m) {
    var r = role(m.role);
    if (r && r.super === true) return true;
    if (typeof cfg.superRole === 'function') return !!cfg.superRole(m);
    return cfg.superRole != null && String(cfg.superRole) === String(m.role);
  }
  function guardKnown() { return cfg.superRole != null || S.roles.some(function (r) { return r.super === true; }); }
  function supers() { return S.ml.filter(function (m) { return isSuper(m) && stKey(m) === 'active'; }); }
  /* يعيد سبب المنع أو '' إن كان مسموحاً (حماية واجهة فقط، والخلفية يجب أن تفرضها أيضاً) */
  function guard(m) {
    if (cfg.me && String(cfg.me()) === m.id) return 'لا يمكنك تعديل دورك أو تعليق وصولك بنفسك.';
    if (!guardKnown() && !cfg.allowWithoutGuard) return 'تعذّر تحديد دور المدير العام، فعُطّلت التعديلات حمايةً من قفل المنصة. عرّف superRole عند التركيب.';
    if (isSuper(m) && stKey(m) === 'active' && supers().length <= 1) return 'هذا آخر مدير عام نشط، ولا يمكن تغييره أو تعليقه من هنا.';
    return '';
  }
  function pv(v) {
    if (v === 'act') return ['اطلاع وتنفيذ', 'btm-y']; if (v === 'view') return ['اطلاع فقط', 'btm-w'];
    if (v === true) return ['مسموح', 'btm-y']; if (v === false) return ['غير مسموح', 'btm-no'];
    return ['غير محدد', 'btm-u'];
  }
  function permsHtml(r) {
    if (!r) return '<p class="btm-e">الدور غير معرّف في قائمة الأدوار.</p>';
    return '<ul class="btm-pl">' + PERMS.map(function (p) {
      var x = pv(r.perms ? r.perms[p[0]] : undefined);
      return '<li><span>' + esc(p[1]) + '</span><em class="' + x[1] + '">' + x[0] + '</em></li>';
    }).join('') + '</ul>';
  }

  /* ---------- البيانات ---------- */
  function normM(r) {
    var m = fn('map') ? cfg.source.map(r) : r;
    if (!m || m.id == null) return null;
    return { id: String(m.id), name: m.name || '', email: m.email || '', avatar: m.avatar || '', role: m.role == null ? '' : String(m.role),
      status: m.status, sections: Array.isArray(m.sections) ? m.sections : null, added: m.added_at || '', last: m.last_activity || '' };
  }
  function fetchMembers() {
    return call('members').then(function (rows) {
      var mp = new Map();                       // المفتاح = id: لا تكرار للعضو نفسه
      (rows || []).forEach(function (r) { var m = normM(r); if (m) mp.set(m.id, m); });
      return Array.from(mp.values());
    });
  }
  function load() {
    if (!cfg) return Promise.resolve();
    if (!fn('members')) { S.status = 'nosrc'; paint(); return Promise.resolve(); }
    S.status = 'loading'; paint();
    var rp = fn('roles') ? call('roles') : Promise.resolve(null);
    var mgp = fn('canManage') ? call('canManage') : Promise.resolve(false);
    return Promise.all([fetchMembers(), rp, mgp]).then(function (a) {
      S.ml = a[0]; S.manage = a[2] === true;
      if (a[1]) {
        S.real = true;
        S.roles = a[1].map(function (r) { return { id: String(r.id), label: r.label || String(r.id), desc: r.desc || '', super: r.super === true, sections: r.sections || null, perms: r.perms || null }; });
      } else { S.real = false; S.roles = ROLES0.map(function (r) { return { id: r.id, label: r.label, desc: r.desc, super: false, sections: null, perms: null }; }); }
      S.status = 'ok';
    }).catch(function () { S.status = 'err'; }).then(paint);
  }
  function reloadAudit() { if (S.v === 'member') loadAudit(S.id); else if (S.v === 'audit') loadAudit(null); }
  function loadAudit(id) {
    var key = id || '*';
    if (!fn('audit') || S.aud[key]) return;
    S.aud[key] = { s: 'loading' }; paint();
    call('audit', { memberId: id || null, limit: id ? 10 : 100 }).then(function (rows) { S.aud[key] = { s: 'ok', rows: rows || [] }; },
      function () { S.aud[key] = { s: 'err' }; }).then(paint);
  }

  /* ---------- العرض ---------- */
  function nav() {
    function b(v, l) { return '<button type="button" data-a="nav" data-v="' + v + '" class="' + (S.v === v || (v === 'list' && S.v === 'member') ? 'on' : '') + '">' + l + '</button>'; }
    return '<div class="btm-nav" role="group" aria-label="أقسام فريق الإدارة">' + b('list', 'الفريق') + b('roles', 'الأدوار والصلاحيات') + b('audit', 'سجل التغييرات') + '</div>';
  }
  function opt(v, l, c) { return '<option value="' + esc(v) + '"' + (v === c ? ' selected' : '') + '>' + esc(l) + '</option>'; }
  function rowsHtml() {
    var f = S.f, q = f.q.toLowerCase();
    var rows = S.ml.filter(function (m) {
      if (f.role && m.role !== f.role) return false;
      if (f.st && stKey(m) !== f.st) return false;
      return !q || (m.name + ' ' + m.email + ' ' + m.id).toLowerCase().indexOf(q) >= 0;
    });
    if (!S.ml.length) return '<p class="btm-e">لا يوجد أعضاء إداريون ظاهرون. لا تُعرض هنا حسابات المستخدمين العاديين.</p>';
    if (!rows.length) return '<p class="btm-e">لا توجد نتائج مطابقة.</p>';
    return '<div class="btm-row btm-hd" aria-hidden="true"><span>العضو</span><span>الدور</span><span>الحالة</span><span>الأقسام</span><span>أُضيف</span></div>' + rows.map(function (m) {
      var r = role(m.role), sec = m.sections || (r && r.sections);
      return '<div class="btm-row"><button type="button" class="btm-who" data-a="open" data-id="' + esc(m.id) + '">' + avatar(m) +
        '<span><strong>' + esc(m.name || 'بدون اسم') + '</strong><small>' + esc(m.email || m.id) + '</small></span></button>' +
        '<span data-l="الدور">' + esc(roleName(m)) + '</span><span data-l="الحالة"><em class="btm-st s-' + stKey(m) + '">' + ST[stKey(m)] + '</em></span>' +
        '<span data-l="الأقسام">' + (sec ? esc(sec.join('، ')) : 'غير محدد') + '</span><span data-l="أُضيف">' + esc(when(m.added) || 'غير مسجّل') + '</span></div>';
    }).join('');
  }
  function listView() {
    var f = S.f;
    return '<div class="btm-bar"><input type="search" data-q aria-label="بحث في الفريق" placeholder="ابحث بالاسم أو البريد" value="' + esc(f.q) + '" autocomplete="off">' +
      '<select data-f="role" aria-label="الدور">' + opt('', 'كل الأدوار', f.role) + S.roles.map(function (r) { return opt(r.id, r.label, f.role); }).join('') + '</select>' +
      '<select data-f="st" aria-label="الحالة">' + opt('', 'كل الحالات', f.st) + opt('active', 'نشط', f.st) + opt('suspended', 'معلّق', f.st) + opt('pending', 'بانتظار القبول', f.st) + '</select>' +
      '<button type="button" class="btm-b" data-a="add">إضافة عضو</button></div><div data-r="rows">' + rowsHtml() + '</div>';
  }
  function actBtn(label, a, id, why) {
    return '<button type="button" class="btm-b o" data-a="' + a + '" data-id="' + esc(id) + '"' + (why ? ' disabled' : '') + '>' + label + '</button>';
  }
  function memberView() {
    var m = S.ml.filter(function (x) { return x.id === S.id; })[0];
    if (!m) return '<button type="button" class="btm-t" data-a="nav" data-v="list">رجوع للفريق</button>' + '<p class="btm-e">العضو غير موجود في القائمة المحمّلة.</p>';
    var r = role(m.role), sk = stKey(m), sec = m.sections || (r && r.sections), why = guard(m), h;
    h = '<button type="button" class="btm-t" data-a="nav" data-v="list">رجوع للفريق</button><div class="btm-card"><div class="btm-who2">' + avatar(m) +
      '<div><h3>' + esc(m.name || 'بدون اسم') + '</h3><small>' + esc(m.email || m.id) + '</small></div></div>' +
      '<dl><dt>الدور الحالي</dt><dd>' + esc(roleName(m)) + '</dd><dt>حالة الحساب</dt><dd><em class="btm-st s-' + sk + '">' + ST[sk] + '</em></dd>' +
      '<dt>الأقسام</dt><dd>' + (sec ? esc(sec.join('، ')) : 'غير محدد') + '</dd><dt>تاريخ الإضافة</dt><dd>' + esc(when(m.added) || 'غير مسجّل') + '</dd>' +
      '<dt>آخر نشاط إداري</dt><dd>' + esc(when(m.last) || 'غير متوفر') + '</dd></dl>';
    if (S.manage) {
      var rr = !fn('setRole') ? 'غير متاح: يحتاج دالة setRole في الخلفية.' : (!S.real ? 'أدوار النظام الفعلية غير مربوطة (source.roles).' : why);
      var ss = !fn('setStatus') ? 'غير متاح: يحتاج دالة setStatus في الخلفية.' : why;
      h += '<div class="btm-ac">' + actBtn('تعديل الدور', 'chrole', m.id, rr) +
        (sk === 'suspended' ? actBtn('إعادة تفعيل الوصول', 'react', m.id, ss) : actBtn('تعليق الوصول', 'susp', m.id, ss)) + '</div>';
      if (rr || ss) h += '<p class="btm-n">' + esc(rr === ss ? rr : [rr, ss].filter(Boolean).join(' · ')) + '</p>';
    } else h += '<p class="btm-n">عرض فقط: لم تُمنح صلاحية إدارة الفريق (canManage).</p>';
    h += '</div><h3>صلاحيات الدور</h3>' + (S.real ? '' : '<p class="btm-n">الدور هنا تسمية مقترحة فقط وغير مربوط بنظام الصلاحيات الفعلي.</p>') + permsHtml(r) +
      '<h3>آخر التغييرات على هذا العضو</h3>' + auditHtml(m.id);
    return h;
  }
  function rolesView() {
    var h = S.real ? '' : '<p class="btm-n">الأدوار الثمانية أدناه تسميات مقترحة فقط. لم يُربط نظام الصلاحيات الفعلي (source.roles)، فلا تُعرض صلاحيات ولا تُفعَّل إجراءات تغيير الدور.</p>';
    return h + '<p class="btm-hint">«اطلاع فقط» لا يمنح قدرة على التعديل. وما لم يُحدَّد في النظام يظهر «غير محدد».</p>' + S.roles.map(function (r) {
      var n = S.ml.filter(function (m) { return m.role === r.id; }).length;
      return '<details class="btm-rl"><summary><strong>' + esc(r.label) + '</strong><small>' + n + ' عضو</small></summary><p>' + esc(r.desc) + '</p>' +
        (r.sections ? '<p><b>الأقسام:</b> ' + esc(r.sections.join('، ')) + '</p>' : '') + permsHtml(r) + '</details>';
    }).join('');
  }
  function auditHtml(id) {
    if (!fn('audit')) return '<p class="btm-e">غير متصل بسجل النشاط الإداري. لا تُعرض سجلات وهمية.</p>';
    var a = S.aud[id || '*'];
    if (!a || a.s === 'loading') return '<p class="btm-e">جارٍ تحميل السجل…</p>';
    if (a.s === 'err') return '<p class="btm-e er" role="alert">تعذّر تحميل السجل.</p>';
    if (!a.rows.length) return '<p class="btm-e">لا توجد أحداث مسجّلة.</p>';
    return '<div class="btm-au">' + a.rows.map(function (e) {
      return '<div class="btm-ar"><strong>' + esc(e.action || 'إجراء') + '</strong><small>' + esc(when(e.at)) + ' · المنفّذ: ' + esc(e.actor || 'غير مسجّل') +
        (e.target ? ' · العضو المتأثر: ' + esc(e.target) : '') + (e.result ? ' · النتيجة: ' + esc(e.result) : '') + '</small></div>';
    }).join('') + '</div><p class="btm-n">السجل للقراءة فقط، وتكتبه الخلفية وحدها.</p>';
  }
  function dialog() {
    var x = S.dlg;
    if (!x) return '';
    var h = '<div class="btm-ov"><div class="btm-dlg" role="dialog" aria-modal="true" aria-label="' + esc(x.title) + '"><h3>' + esc(x.title) + '</h3>' + x.body();
    if (x.err) h += '<p class="btm-e er" role="alert">' + esc(x.err) + '</p>';
    h += '<div class="btm-ac"><button type="button" class="btm-b" data-a="dok"' + (x.busy || x.ok === false ? ' disabled' : '') + '>' + esc(x.okLabel) + '</button>' +
      '<button type="button" class="btm-b o" data-a="dno"' + (x.busy ? ' disabled' : '') + '>إلغاء</button></div></div></div>';
    return h;
  }
  function paint() {
    if (!cfg) return;
    var h = '<div class="btm-h"><h2>فريق الإدارة والصلاحيات</h2><button type="button" class="btm-t" data-a="refresh">تحديث</button></div>' + nav();
    if (S.msg) h += '<p class="btm-m ' + S.msg.t + '" role="status">' + esc(S.msg.x) + '</p>';
    if (S.status === 'nosrc') h += '<p class="btm-e">لم يُربط مصدر بيانات بعد. عرّف source.members عند التركيب.</p>';
    else if (S.status === 'idle' || S.status === 'loading') h += '<p class="btm-e">جارٍ تحميل فريق الإدارة…</p>';
    else if (S.status === 'err') h += '<p class="btm-e er" role="alert">تعذّر تحميل بيانات الفريق.</p><div class="btm-ac"><button type="button" class="btm-b o" data-a="refresh">إعادة المحاولة</button></div>';
    else h += S.v === 'member' ? memberView() : S.v === 'roles' ? rolesView() : S.v === 'audit' ? '<div>' + auditHtml(null) + '</div>' : listView();
    root.innerHTML = h + dialog();
    var f = root.querySelector('.btm-dlg button:not([disabled]),.btm-dlg input,.btm-dlg select'); if (f) f.focus();
  }

  /* ---------- الإجراءات الحساسة (بتأكيد، والنتيجة من الخلفية فقط) ---------- */
  function openRole(id) {
    var m = S.ml.filter(function (x) { return x.id === id; })[0], why = m && guard(m);
    if (!m || why || !S.real || !fn('setRole')) return;
    var x = { title: 'تعديل دور ' + (m.name || m.email || m.id), okLabel: 'تعديل الدور', to: '', ok: false,
      body: function () {
        var to = role(x.to), cur = role(m.role);
        return '<p>الدور الحالي: <strong>' + esc(roleName(m)) + '</strong></p><label>الدور الجديد<select data-d="to">' + opt('', 'اختر دوراً', x.to) +
          S.roles.filter(function (r) { return r.id !== m.role; }).map(function (r) { return opt(r.id, r.label, x.to); }).join('') + '</select></label>' +
          (to ? '<p class="btm-n">الأثر: ستتبع صلاحيات العضو الدور الجديد، وقد يفقد الوصول إلى أقسام لا يشملها' + (cur && isSuper(m) ? '، وسيفقد صلاحيات المدير العام' : '') + '.</p>' + permsHtml(to) : '');
      } };
    x.exec = function () { return cfg.source.setRole(m.id, x.to); };
    x.verify = function (list) { var n = list.filter(function (z) { return z.id === m.id; })[0]; return !!n && n.role === x.to; };
    x.done = 'تم تعديل الدور';
    S.dlg = x; paint();
  }
  function openStatus(id, to) {
    var m = S.ml.filter(function (z) { return z.id === id; })[0], why = m && guard(m);
    if (!m || why || !fn('setStatus')) return;
    var sus = to === 'suspended', name = m.name || m.email || m.id;
    var x = { title: (sus ? 'تعليق وصول ' : 'إعادة تفعيل وصول ') + name, okLabel: sus ? 'تعليق الوصول' : 'إعادة تفعيل الوصول', ok: true,
      body: function () {
        return sus ? '<p>الأثر: يفقد العضو الوصول إلى لوحة الإدارة بعد نجاح الإجراء في الخلفية. لا يُحذف حسابه ولا سجلاته، ويمكن إعادة تفعيله لاحقاً.</p>'
          : '<p>الأثر: يستعيد العضو وصوله الإداري وفق دوره الحالي: <strong>' + esc(roleName(m)) + '</strong>.</p>';
      } };
    x.exec = function () { return cfg.source.setStatus(m.id, to); };
    x.verify = function (list) { var n = list.filter(function (z) { return z.id === m.id; })[0]; return !!n && stKey(n) === (sus ? 'suspended' : 'active'); };
    x.done = sus ? 'تم تعليق الوصول' : 'تمت إعادة تفعيل الوصول';
    S.dlg = x; paint();
  }
  function openAdd() {
    if (!S.manage) return;
    if (!fn('addMember') && !fn('invite')) {
      S.dlg = { title: 'إضافة عضو إداري', okLabel: 'حسناً', ok: true, body: function () {
        return '<p>غير متاح الآن: لا توجد آلية آمنة لإضافة عضو أو دعوته. لم تُنشأ واحدة داخل الواجهة عمداً.</p>' +
          '<p>المطلوب خلفياً: دالة تتحقق من أن المنفّذ مدير عام، وتعيّن دوراً على حساب موجود (أو ترسل دعوة)، وتكتب سجل التدقيق من الخادم، بلا كلمات مرور افتراضية.</p>'; } };
      S.dlg.exec = null; paint(); return;
    }
    var x = { title: 'إضافة عضو إداري', okLabel: 'إضافة العضو', ok: false, mode: fn('addMember') ? 'acc' : 'inv', q: '', res: null, pick: '', email: '', to: '', searching: false,
      body: function () {
        var h = '';
        if (fn('addMember') && fn('invite')) h += '<div class="btm-nav"><button type="button" data-a="dmode" data-v="acc" class="' + (x.mode === 'acc' ? 'on' : '') + '">حساب موجود</button><button type="button" data-a="dmode" data-v="inv" class="' + (x.mode === 'inv' ? 'on' : '') + '">دعوة بالبريد</button></div>';
        if (x.mode === 'acc') {
          h += '<div class="btm-bar"><input type="search" data-d="q" aria-label="ابحث عن حساب" placeholder="ابحث عن حساب موجود" value="' + esc(x.q) + '" autocomplete="off"><button type="button" class="btm-b o" data-a="dsearch"' + (x.searching || !fn('searchAccounts') ? ' disabled' : '') + '>بحث</button></div>';
          if (!fn('searchAccounts')) h += '<p class="btm-n">غير متاح: يحتاج دالة searchAccounts تعيد الحسابات المسموح تعيينها فقط.</p>';
          if (x.res) h += x.res.length ? x.res.map(function (a) { return '<label class="btm-pk"><input type="radio" name="btmpk" data-d="pick" value="' + esc(a.id) + '"' + (x.pick === String(a.id) ? ' checked' : '') + '> ' + esc(a.name || a.email || a.id) + (a.email && a.name ? '<small> ' + esc(a.email) + '</small>' : '') + '</label>'; }).join('') : '<p class="btm-e">لا توجد حسابات مطابقة.</p>';
        } else h += '<label>البريد الإلكتروني للدعوة<input type="email" data-d="email" value="' + esc(x.email) + '" autocomplete="off"></label>';
        h += '<label>الدور<select data-d="to">' + opt('', 'اختر دوراً', x.to) + S.roles.map(function (r) { return opt(r.id, r.label, x.to); }).join('') + '</select></label>';
        if (!S.real) h += '<p class="btm-n">أدوار النظام الفعلية غير مربوطة، فلا يمكن تأكيد الإضافة.</p>';
        if (role(x.to)) h += '<p class="btm-n">راجع الصلاحيات قبل الحفظ:</p>' + permsHtml(role(x.to));
        return h;
      } };
    x.calc = function () { x.ok = S.real && !!x.to && (x.mode === 'acc' ? !!x.pick : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.email)); };
    x.exec = function () { return x.mode === 'acc' ? cfg.source.addMember({ accountId: x.pick, roleId: x.to }) : cfg.source.invite({ email: x.email, roleId: x.to }); };
    x.verify = function (list) { return x.mode === 'inv' ? true : list.some(function (z) { return z.id === String(x.pick); }); };
    x.done = 'تمت إضافة العضو'; x.doneInv = 'أُرسلت الدعوة';
    x.calc(); S.dlg = x; paint();
  }
  function confirmDlg() {
    var x = S.dlg;
    if (!x || x.busy || !x.exec || x.ok === false) { if (x && !x.exec) { S.dlg = null; paint(); } return; }
    x.busy = true; x.err = ''; paint();
    Promise.resolve().then(x.exec).then(function () {
      return fetchMembers().then(function (list) { S.ml = list; return x.verify(list); }, function () { return null; });
    }).then(function (ok) {
      var msg = x.mode === 'inv' ? x.doneInv : x.done;
      S.msg = ok === false ? { t: 'er', x: 'قُبل الطلب لكن الحالة المحمّلة لم تتغيّر. راجع القائمة قبل الاعتماد.' }
        : ok === null ? { t: 'ok', x: msg + '، وتعذّر تحديث القائمة للتحقق.' } : { t: 'ok', x: msg + '.' };
      S.dlg = null; S.aud = {}; paint(); reloadAudit();
    }, function (e) {
      x.busy = false; x.err = (e && typeof e.userMessage === 'string' && e.userMessage) || 'فشل تنفيذ الإجراء، ولم يتغيّر شيء.'; paint();
    });
  }

  /* ---------- التفاعل ---------- */
  function onClick(e) {
    var t = e.target.closest('[data-a]');
    if (!t) return;
    var a = t.getAttribute('data-a'), id = t.getAttribute('data-id');
    if (a === 'nav') { S.v = t.getAttribute('data-v'); S.id = null; S.msg = null; paint(); if (S.v === 'audit') loadAudit(null); }
    else if (a === 'open') { S.v = 'member'; S.id = id; S.msg = null; paint(); loadAudit(id); }
    else if (a === 'refresh') { S.aud = {}; load().then(reloadAudit); }
    else if (a === 'add') openAdd();
    else if (a === 'chrole') openRole(id);
    else if (a === 'susp') openStatus(id, 'suspended');
    else if (a === 'react') openStatus(id, 'active');
    else if (a === 'dno') { if (S.dlg && !S.dlg.busy) { S.dlg = null; paint(); } }
    else if (a === 'dok') confirmDlg();
    else if (a === 'dmode') { S.dlg.mode = t.getAttribute('data-v'); S.dlg.calc(); paint(); }
    else if (a === 'dsearch') {
      var x = S.dlg; x.searching = true; x.err = ''; paint();
      call('searchAccounts', x.q).then(function (r) { x.res = r || []; }, function () { x.err = 'تعذّر البحث عن الحسابات.'; }).then(function () { x.searching = false; x.pick = ''; x.calc(); paint(); });
    }
  }
  function onInput(e) {
    var t = e.target;
    if (t.hasAttribute('data-q')) { S.f.q = t.value; var r = root.querySelector('[data-r="rows"]'); if (r) r.innerHTML = rowsHtml(); }
    else if (S.dlg && (t.getAttribute('data-d') === 'q' || t.getAttribute('data-d') === 'email')) { S.dlg[t.getAttribute('data-d')] = t.value; if (S.dlg.calc) S.dlg.calc(); var b = root.querySelector('[data-a="dok"]'); if (b) b.disabled = S.dlg.ok === false; }
  }
  function onChange(e) {
    var t = e.target, f = t.getAttribute('data-f'), dk = t.getAttribute('data-d');
    if (f) { S.f[f] = t.value; var r = root.querySelector('[data-r="rows"]'); if (r) r.innerHTML = rowsHtml(); }
    else if (S.dlg && dk === 'to') { S.dlg.to = t.value; if (S.dlg.calc) S.dlg.calc(); else S.dlg.ok = !!t.value; paint(); }
    else if (S.dlg && dk === 'pick') { S.dlg.pick = t.value; S.dlg.calc(); paint(); }
  }
  function onKey(e) {
    if (e.key === 'Escape' && S.dlg && !S.dlg.busy) { S.dlg = null; paint(); }
    else if (e.key === 'Enter' && S.dlg && e.target.getAttribute && e.target.getAttribute('data-d') === 'q') { e.preventDefault(); var b = root.querySelector('[data-a="dsearch"]'); if (b && !b.disabled) b.click(); }
  }

  var CSS = '.btm{direction:rtl;color:var(--ink,#0E1B2E);font:400 14px/1.6 var(--f,"Readex Pro","Segoe UI",Tahoma,sans-serif);background:#fff;border:1px solid var(--line,#DCE3EB);border-radius:14px;padding:16px;min-width:0}' +
    '.btm[hidden]{display:none}.btm button,.btm input,.btm select{font:inherit}.btm h2{margin:0;font-size:20px}.btm h3{margin:16px 0 8px;font-size:16px}' +
    '.btm-h{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
    '.btm-t{background:none;border:0;color:var(--b,#1A4FA0);cursor:pointer;min-height:44px;padding:0 8px;font-size:13px}' +
    '.btm-nav{display:flex;gap:6px;overflow-x:auto;padding:8px 0}.btm-nav button{flex:none;white-space:nowrap;border:1px solid var(--line,#DCE3EB);background:#fff;color:inherit;border-radius:99px;padding:6px 16px;min-height:44px;cursor:pointer}' +
    '.btm-nav button.on{background:var(--nav,#06193A);border-color:var(--nav,#06193A);color:#fff}' +
    '.btm-bar{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.btm-bar input[type=search]{flex:1 1 200px}' +
    '.btm input[type=search],.btm input[type=email],.btm select{min-height:44px;font-size:16px;border:1px solid var(--line,#DCE3EB);border-radius:10px;padding:8px 12px;background:#fff;color:inherit;box-sizing:border-box}' +
    '.btm label{display:grid;gap:4px;margin:10px 0}.btm label select,.btm label input[type=email]{width:100%}' +
    '.btm-b{background:var(--b,#1A4FA0);color:#fff;border:1.5px solid var(--b,#1A4FA0);border-radius:10px;padding:8px 18px;min-height:44px;cursor:pointer;font-weight:600}' +
    '.btm-b.o{background:#fff;color:var(--b,#1A4FA0)}.btm-b[disabled]{opacity:.45;cursor:default}' +
    '.btm-row{display:grid;grid-template-columns:2fr 1.2fr .9fr 1.6fr 1.2fr;gap:10px;align-items:center;padding:10px 4px;border-bottom:1px solid var(--line,#DCE3EB)}' +
    '.btm-hd{font-weight:600;color:var(--mut,#5B6879);font-size:12px}' +
    '.btm-who{display:flex;align-items:center;gap:10px;background:none;border:0;color:inherit;cursor:pointer;text-align:start;min-height:44px;padding:0;min-width:0}' +
    '.btm-who strong,.btm-who small{display:block;overflow:hidden;text-overflow:ellipsis}.btm-who small,.btm small{color:var(--mut,#5B6879);font-size:12px}' +
    '.btm-av{flex:none;width:40px;height:40px;border-radius:50%;object-fit:cover;background:var(--cloud,#EDF1F5);color:var(--nav,#06193A);display:inline-grid;place-items:center;font-weight:600}' +
    '.btm-st{font-style:normal;border-radius:99px;padding:0 10px;font-size:12px;white-space:nowrap}.s-active{background:#d8f3e4;color:#0b6b3a}.s-suspended{background:#fde0dc;color:#a02a1c}.s-pending{background:#fff3d6;color:#7a5200}.s-other{background:#edf1f5;color:#3f4d63}' +
    '.btm-card{border:1px solid var(--line,#DCE3EB);border-radius:12px;padding:14px;margin-top:8px}.btm-who2{display:flex;align-items:center;gap:12px}.btm-who2 h3{margin:0}' +
    '.btm dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:12px 0}.btm dt{color:var(--mut,#5B6879)}.btm dd{margin:0}' +
    '.btm-ac{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}' +
    '.btm-pl{list-style:none;margin:0;padding:0;border:1px solid var(--line,#DCE3EB);border-radius:12px;overflow:hidden}.btm-pl li{display:flex;justify-content:space-between;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line,#DCE3EB)}.btm-pl li:last-child{border:0}' +
    '.btm-pl em{font-style:normal;border-radius:99px;padding:0 10px;font-size:12px;white-space:nowrap}.btm-y{background:#d8f3e4;color:#0b6b3a}.btm-w{background:#e3edff;color:#133E82}.btm-no{background:#fde0dc;color:#a02a1c}.btm-u{background:#edf1f5;color:#3f4d63}' +
    '.btm-rl{border:1px solid var(--line,#DCE3EB);border-radius:12px;margin:8px 0;padding:0 14px}.btm-rl summary{min-height:48px;display:flex;align-items:center;gap:10px;cursor:pointer}.btm-rl summary small{margin-inline-start:auto}.btm-rl .btm-pl{margin-bottom:12px}' +
    '.btm-au .btm-ar{padding:8px 0;border-bottom:1px solid var(--line,#DCE3EB)}.btm-ar strong,.btm-ar small{display:block}' +
    '.btm-e{margin:0;padding:16px 8px;text-align:center;color:var(--mut,#5B6879)}.btm-e.er{color:#a02a1c}.btm-hint{color:var(--mut,#5B6879);font-size:13px}' +
    '.btm p.btm-n{margin:8px 0;padding:8px 12px;font-size:12px;color:var(--mut,#5B6879);background:#fff8e6;border-radius:8px}' +
    '.btm-m{margin:8px 0;padding:10px 14px;border-radius:10px}.btm-m.ok{background:#d8f3e4;color:#0b6b3a}.btm-m.er{background:#fde0dc;color:#a02a1c}' +
    '.btm-ov{position:fixed;inset:0;z-index:80;background:rgba(6,25,58,.55);display:grid;place-items:center;padding:12px}' +
    '.btm-dlg{background:#fff;border-radius:14px;padding:16px 18px;width:min(520px,100%);max-height:88vh;overflow:auto}.btm-dlg h3{margin:0 0 8px}.btm-pk{display:flex;align-items:center;gap:8px;min-height:44px;margin:0}.btm-pk input{width:22px;height:22px}' +
    '.btm button:focus-visible,.btm input:focus-visible,.btm select:focus-visible,.btm summary:focus-visible{outline:3px solid #E0A81B;outline-offset:2px}' +
    '@media(max-width:720px){.btm-hd{display:none}.btm-row{grid-template-columns:1fr;gap:2px;padding:12px 4px}.btm-row [data-l]::before{content:attr(data-l) ": ";color:var(--mut,#5B6879);font-size:12px}}';

  /* ---------- الواجهة العامة ---------- */
  function setHidden(on) {
    if (!cfg.hideWhileOpen) return;
    var el = d.querySelector(cfg.hideWhileOpen);
    if (!el) return;
    if (on) { hid = el; el.style.display = 'none'; } else if (hid) { hid.style.display = ''; hid = null; }
  }
  function open() { if (!cfg) return; root.hidden = false; setHidden(true); if (S.status === 'idle') load(); }
  function close() { if (!cfg) return; root.hidden = true; setHidden(false); }
  function mount(o) {
    o = o || {};
    if (cfg) { console.warn('BahrTeam: مُركّبة مسبقاً'); return false; }
    if (o.canAccess && !o.canAccess()) return false;
    var r = o.root && d.querySelector(o.root);
    if (!r) { console.warn('BahrTeam: لم أجد العنصر', o.root); return false; }
    cfg = o; root = r; root.classList.add('btm');
    if (!d.getElementById('btm-css')) { var st = d.createElement('style'); st.id = 'btm-css'; st.textContent = CSS; d.head.appendChild(st); }
    root.addEventListener('click', onClick); root.addEventListener('input', onInput);
    root.addEventListener('change', onChange); root.addEventListener('keydown', onKey);
    var tr = o.trigger && d.querySelector(o.trigger);
    if (tr) { root.hidden = true; tr.addEventListener('click', function (e) { e.preventDefault(); open(); }); }
    (o.autoCloseOn || []).forEach(function (sel) {
      var el = d.querySelector(sel);
      if (el) el.addEventListener('click', function (e) { if (!root.hidden && !(tr && tr.contains(e.target))) close(); }, true);
    });
    if (!tr) load();
    return true;
  }

  w.BahrTeam = { mount: mount, open: open, close: close, refresh: load };
  function bahrBoot() {
  BahrNotify.mount({ bell: '#admNtfBell' });
  if (BahrTeam.mount({ root: '#admTeamPage', trigger: '#admTeamBtn' })) {
    document.getElementById('admTeamBtn').style.display = '';
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bahrBoot);
else bahrBoot();

})(window, document);
