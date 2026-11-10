/* ==========================================================================
 * 本地数据自动同步  data-sync.js
 *
 * 作用：把浏览器 localStorage 里的 observer_* 数据，自动保存到项目目录下的
 *       「产品数据.json」；换端口 / 克隆文件夹后自动恢复。
 *
 * 为什么需要：localStorage 按「协议 + 主机 + 端口」隔离，克隆项目文件夹带不走
 *            数据，换端口等于换了一个空存储区（表现就是各银行产品数量对不上）。
 *
 * 同步规则（按时间戳，确定且可预测）：
 *   1. 文件不存在 + 本页有数据          → 把本页数据写入文件（首次建立）
 *   2. 文件比本页记录的新               → 用文件覆盖本页（克隆/换端口后自动恢复）
 *   3. 本页从未同步过 + 文件已有数据     → 以文件为准
 *   4. 本页比文件新                     → 写回文件
 *   之后本页数据一有变化，就防抖写回文件。
 *
 * 页面和接口在同一台服务上。无论用域名、局域网还是本机地址打开，都同步这台服务的数据。
 * 临时停用：在网址后加 ?nosync=1
 * 手动控制：控制台执行 DataSync.info() / DataSync.push()
 * ========================================================================== */
(function () {
  "use strict";

  var PREFIX = "observer_";        // 只同步这个前缀的键
  // 字号是本机显示偏好。产品目录 observer_reg_v1 只由服务端 /api/catalog 写入，
  // 浏览器整包同步不能把它推回去，否则删掉的产品会从旧缓存里复活。
  // 净值 observer_lookup_* 只由 /api/nav 按产品写入。整包再带上全部序列，
  // 请求体会到数 MB，反代默认约 1MB 时直接 413。
  var EXCLUDE = { observer_fs: 1, observer_reg_v1: 1, observer_lookup_real: 1, observer_lookup_icbc: 1 };
  var API = "/api/state";
  var STAMP = "datasync_savedAt";  // 记录本页最后一次同步的文件时间戳（不参与同步）
  var DEBOUNCE_MS = 1200;

  if (/[?&]nosync=1/.test(location.search)) {
    console.log("[data-sync] 已按 ?nosync=1 跳过同步");
    return;
  }

  /* ---------------- 基础工具 ---------------- */
  function collect() {
    var o = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(PREFIX) === 0 && !EXCLUDE[k]) o[k] = localStorage.getItem(k);
    }
    return o;
  }
  function count(o) {
    var n = 0;
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) n++;
    return n;
  }
  function sig(o) { return count(o) + ":" + JSON.stringify(o).length; }
  function getStamp() { try { return localStorage.getItem(STAMP) || ""; } catch (e) { return ""; } }
  function setStamp(v) { try { localStorage.setItem(STAMP, v || ""); } catch (e) {} }

  /* 覆盖本页数据之前，先把它留一份底（键名不以 observer_ 开头，不参与同步）。
     万一把「旧的空数据」当成基准，还能用 DataSync.backup() 找回。 */
  function backupLocal() {
    try {
      var o = collect();
      if (!count(o)) return;
      localStorage.setItem("datasync_backup",
        JSON.stringify({ at: new Date().toISOString(), origin: location.origin, data: o }));
    } catch (e) { /* 配额不足等，忽略 */ }
  }

  /* ---------------- 与服务端通信 ---------------- */
  function getSync(url) {
    var x = new XMLHttpRequest();
    x.open("GET", url, false);   // 同步：必须赶在页面脚本读取 localStorage 之前完成
    x.send(null);
    return x;
  }
  function post(data, useBeacon) {
    var body = JSON.stringify({ data: data });
    if (useBeacon && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(API, new Blob([body], { type: "application/json" }))) return;
      } catch (e) { /* 回落异步 XHR */ }
    }
    try {
      var x = new XMLHttpRequest();
      x.open("POST", API, true);
      x.setRequestHeader("Content-Type", "application/json");
      x.onload = function () {
        /* 记下服务端写入的时间戳，下次加载才知道本页是否比文件旧 */
        try {
          var j = JSON.parse(x.responseText || "{}");
          if (j && j.savedAt) setStamp(j.savedAt);
        } catch (e) {}
      };
      x.send(body);
    } catch (e) { /* 静默 */ }
  }

  var lastSig = "";
  var timer = null;
  function flush(useBeacon) {
    if (timer) { clearTimeout(timer); timer = null; }
    var o = collect();
    if (!count(o)) return;
    var s = sig(o);
    if (s === lastSig) return;
    lastSig = s;
    post(o, !!useBeacon);
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { flush(false); }, DEBOUNCE_MS);
  }

  /* ---------------- 启动：决定以文件为准还是以本页为准 ---------------- */
  var srv = null, enabled = false;
  try {
    var r = getSync(API + "?view=boot&t=" + Date.now());
    if (r.status === 200) { srv = JSON.parse(r.responseText || "{}"); enabled = true; }
    /* 其它状态（如旧版 serve.mjs 返回 404）→ enabled 保持 false，本次不同步 */
  } catch (e) {
    console.warn("[data-sync] 无法连接本地服务，本次跳过同步：" + e.message);
  }

  var FILE = (srv && srv.file) || "产品数据.json";

  if (enabled && srv && typeof srv === "object") {
    var srvData = (srv.data && typeof srv.data === "object") ? srv.data : {};
    var srvN = count(srvData);
    var srvAt = srv.savedAt || "";
    var myStamp = getStamp();
    var localN = count(collect());

    /* 产品目录和净值都始终以服务器文件为准。手机、电脑各有一份浏览器缓存，不能互相覆盖。 */
    if (srvData.observer_reg_v1) {
      try { localStorage.setItem("observer_reg_v1", srvData.observer_reg_v1); } catch (e) {}
    }
    // 旧缓存里的整表净值不再回灌。列表和详情分别走 /api/products、/api/nav。
    try {
      localStorage.removeItem("observer_lookup_real");
      localStorage.removeItem("observer_lookup_icbc");
    } catch (e) {}
    if (srvN > 0 && (!myStamp || (srvAt && srvAt > myStamp))) {
      /* 文件存在，且本页从未同步过 / 文件更新 → 以文件为准 */
      if (localN > 0) backupLocal();   // 覆盖前先留底
      var applied = 0;
      for (var k in srvData) {
        if (!Object.prototype.hasOwnProperty.call(srvData, k)) continue;
        if (k === "observer_fs") continue;        // 字号等显示偏好不覆盖本机
        if (k.indexOf("observer_lookup_") === 0) continue;  // 净值不从整包状态回灌
        try { localStorage.setItem(k, srvData[k]); applied++; } catch (e) {}
      }
      setStamp(srvAt);
      lastSig = sig(collect());
      console.log("[data-sync] 已从「" + FILE + "」恢复 " + applied + " 个键（文件保存于 " + srvAt + "）");
    } else if (localN > 0 && (!srvN || !myStamp || (myStamp && srvAt && myStamp > srvAt))) {
      /* 文件不存在 / 本页从未同步过 / 本页更新 → 写回文件（不含产品目录） */
      post(collect(), false);
      console.log("[data-sync] 本页数据已写入「" + FILE + "」（产品目录保持服务端原样）");
    }
  }

  /* ---------------- 一次性字号默认值迁移（2026-10-14） ----------------
     旧版本把字号偏好 observer_fs 当数据一起同步，换电脑后会沿用旧字号。
     这里把默认值统一到 1.01（0.84 基础上再放大 20%），只做一次；
     之后用户自己调过的字号不会再被覆盖。标记键用 datasync_ 前缀 → 不参与同步。 */
  var FS_VER_KEY = "datasync_fs_ver", FS_VER_VAL = "1.01";
  try {
    if (localStorage.getItem(FS_VER_KEY) !== FS_VER_VAL) {
      localStorage.setItem("observer_fs", FS_VER_VAL);
      localStorage.setItem(FS_VER_KEY, FS_VER_VAL);
      console.log("[data-sync] 字号默认值已更新为 " + FS_VER_VAL);
    }
  } catch (e) {}

  /* 服务端没提供持久化接口（旧版 serve.mjs）→ 完全停用，免得白发请求 */
  if (!enabled) {
    console.log("[data-sync] 本地服务未提供 /api/state，本次不同步（重启 serve.mjs 后生效）");
    return;
  }

  /* 记下当前状态：这样关页兜底时，没变过的数据不会被重复写一遍 */
  lastSig = sig(collect());

  /* ---------------- 数据一变化就防抖写回 ---------------- */
  try {
    var _set = Storage.prototype.setItem;
    var _rm = Storage.prototype.removeItem;
    var _clr = Storage.prototype.clear;
    Storage.prototype.setItem = function (k, v) {
      _set.call(this, k, v);
      if (this === localStorage && String(k).indexOf(PREFIX) === 0) schedule();
    };
    Storage.prototype.removeItem = function (k) {
      _rm.call(this, k);
      if (this === localStorage && String(k).indexOf(PREFIX) === 0) schedule();
    };
    Storage.prototype.clear = function () {
      _clr.call(this);
      if (this === localStorage) schedule();
    };
  } catch (e) {
    console.warn("[data-sync] 无法挂钩 localStorage 写入：" + e.message);
  }

  /* ---------------- 关页 / 切后台兜底 ---------------- */
  window.addEventListener("pagehide", function () { flush(true); });
  window.addEventListener("beforeunload", function () { flush(true); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush(true);
  });

  /* ---------------- 手动控制 ---------------- */
  window.DataSync = {
    push: function () { lastSig = ""; flush(false); return count(collect()); },
    info: function () { return { origin: location.origin, file: FILE, keys: count(collect()), stamp: getStamp() }; },
    /* 查看上一次被覆盖前的本页数据留底 */
    backup: function () {
      try { return JSON.parse(localStorage.getItem("datasync_backup") || "null"); } catch (e) { return null; }
    },
    /* 用留底覆盖回本页（回滚误覆盖） */
    restoreBackup: function () {
      var b = this.backup();
      if (!b || !b.data) return 0;
      var n = 0;
      for (var k in b.data) {
        if (!Object.prototype.hasOwnProperty.call(b.data, k)) continue;
        try { localStorage.setItem(k, b.data[k]); n++; } catch (e) {}
      }
      lastSig = "";
      console.log("[data-sync] 已用留底（" + b.at + "）恢复 " + n + " 个键，请刷新页面");
      return n;
    }
  };
})();
