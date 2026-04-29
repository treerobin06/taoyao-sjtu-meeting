// ==UserScript==
// @name         SJTU 云视频会议工具箱
// @namespace    https://meeting.sjtu.edu.cn/
// @version      3.1
// @description  上海交大云视频会议一站式工具：批量创建（多任务行+预设+会议组）/ 扫表筛选 / snapshot 提取 / 含链接缓存 / 自定义模板 / 当天明天勾选 / ICS 导出 / 原生批量删除 / 删除回收站
// @author       You
// @match        https://meeting.sjtu.edu.cn/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
  'use strict';

  // ========== 通用工具 ==========

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const uid = () => 'r' + Math.random().toString(36).slice(2, 9);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'className') node.className = attrs[k];
        else if (k === 'dataset') Object.assign(node.dataset, attrs[k]);
        else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(node.style, attrs[k]);
        else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
        else if (k in node) {
          try { node[k] = attrs[k]; } catch (_) { node.setAttribute(k, attrs[k]); }
        }
        else node.setAttribute(k, attrs[k]);
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function simulateInput(input, value) {
    input.focus();
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    setNativeValue(input, value);
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    input.blur();
  }

  function findButtonByText(text, container) {
    const root = container || document;
    for (const b of root.querySelectorAll('button')) {
      if (b.textContent.trim().includes(text)) return b;
    }
    return null;
  }

  function findLinkByText(container, text) {
    for (const a of container.querySelectorAll('a, span')) {
      if (a.textContent.trim().includes(text)) return a.closest('a') || a;
    }
    return null;
  }

  function waitFor(fn, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const r = fn();
      if (r) return resolve(r);
      const obs = new MutationObserver(() => {
        const r = fn();
        if (r) { obs.disconnect(); resolve(r); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error('waitFor 超时')); }, timeout);
    });
  }

  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const todayStr = () => fmtDate(new Date());
  const tomorrowStr = () => { const d = new Date(); d.setDate(d.getDate() + 1); return fmtDate(d); };

  function generateDates(startStr, endStr, weekdays) {
    const out = [];
    if (!startStr || !endStr || !weekdays || !weekdays.length) return out;
    const start = new Date(startStr + 'T00:00:00');
    const end = new Date(endStr + 'T00:00:00');
    if (isNaN(start) || isNaN(end)) return out;
    const cur = new Date(start);
    while (cur <= end) {
      if (weekdays.includes(cur.getDay())) out.push(fmtDate(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const DURATION_OPTIONS = ['0.5小时', '1小时', '1.5小时', '2小时', '2.5小时', '3小时', '3.5小时', '4小时'];

  // ========== 全局状态 ==========
  let cancelFlag = false;
  let currentTab = 'create';
  let rows = [];        // 创建任务行
  let presets = [];     // 预设
  let groups = [];      // 会议组（v3.0 遗留，v3.1 起改用 tag）
  let activeTagFilter = '';  // 当前选中的 tag 筛选（'' = 全部）
  let scanned = [];     // 扫描结果
  let lastResult = '';
  let editingPresetRef = null;

  let globals = {
    defaultPassword: '000000',
    defaultCohost: '',
    rangeStart: '',
    rangeWeeks: 4,
    delaySeconds: 3,
    outputTemplate: '',
  };

  function rangeStartDate() { return globals.rangeStart || todayStr(); }
  function rangeEndDate() {
    const start = new Date(rangeStartDate() + 'T00:00:00');
    if (isNaN(start)) return '';
    const w = Math.max(1, parseInt(globals.rangeWeeks, 10) || 4);
    const end = new Date(start);
    end.setDate(end.getDate() + 7 * w - 1);
    return fmtDate(end);
  }

  function defaultRow() {
    return {
      id: uid(),
      topic: '', password: globals.defaultPassword || '', cohost: globals.defaultCohost || '',
      startDate: rangeStartDate(), endDate: rangeEndDate(),
      weekdays: [], time: '09:00', duration: '3小时',
      collapsed: false,
    };
  }

  // ========== localStorage ==========
  const LS = {
    presets: 'sjtu_meeting_presets',
    groups: 'sjtu_meeting_groups',
    globals: 'sjtu_meeting_globals',
    rows: 'sjtu_meeting_rows_v3',
    inviteCache: 'sjtu_meeting_invite_cache',
    recycleBin: 'sjtu_meeting_recyclebin',
    runtimeTask: 'sjtu_batch_task_v2',
  };
  function lsLoad(key, fallback) {
    try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; }
    catch (e) { return fallback; }
  }
  function lsSave(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); }
    catch (e) { console.error('lsSave fail', key, e); }
  }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }

  // ========== 样式 ==========
  GM_addStyle(`
    #sjtu-tk-fab {
      position: fixed; bottom: 30px; right: 30px; z-index: 99999;
      width: 60px; height: 60px; border-radius: 50%;
      background: linear-gradient(135deg, #409EFF, #67C23A); color: #fff; border: none; cursor: pointer;
      font-size: 24px; line-height: 60px; text-align: center;
      box-shadow: 0 4px 14px rgba(0,0,0,.3);
      transition: transform .2s, box-shadow .2s; user-select: none;
    }
    #sjtu-tk-fab:hover { transform: scale(1.12); box-shadow: 0 8px 22px rgba(0,0,0,.4); }

    .sjtu-tk-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,.45);
      z-index: 100000; display: none; align-items: center; justify-content: center;
    }
    .sjtu-tk-overlay.active { display: flex; }
    #sjtu-tk-overlay-edit { z-index: 100002; }
    #sjtu-tk-overlay-preset-pick { z-index: 100001; }
    #sjtu-tk-overlay-recycle { z-index: 100002; }
    #sjtu-tk-overlay-group { z-index: 100002; }
    #sjtu-tk-overlay-presets { z-index: 100001; }

    .sjtu-tk-panel {
      background: #fff; border-radius: 12px; width: 820px;
      max-height: 92vh; overflow-y: auto;
      box-shadow: 0 8px 30px rgba(0,0,0,.25);
      padding: 22px 26px;
      font-family: 'Microsoft YaHei','PingFang SC',sans-serif; color: #333;
    }
    .sjtu-tk-panel.sm { width: 600px; }
    .sjtu-tk-panel.md { width: 700px; }

    .sjtu-tk-h {
      margin: 0 0 14px; font-size: 19px; color: #409EFF;
      border-bottom: 2px solid #409EFF; padding-bottom: 10px;
      display: flex; justify-content: space-between; align-items: center;
    }
    .sjtu-tk-h .sub { font-size: 12px; font-weight: normal; color: #999; }
    .sjtu-tk-h h3 { margin: 0; font-size: 16px; }

    /* tab bar */
    .sjtu-tk-tabs {
      display: flex; gap: 0; margin-bottom: 14px;
      border-bottom: 2px solid #ebeef5;
    }
    .sjtu-tk-tab {
      padding: 9px 20px; cursor: pointer; user-select: none;
      font-size: 14px; font-weight: 600; color: #909399;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px; transition: all .15s;
    }
    .sjtu-tk-tab:hover { color: #409EFF; }
    .sjtu-tk-tab.active { color: #409EFF; border-bottom-color: #409EFF; }
    .sjtu-tk-tab .badge {
      background: #f56c6c; color: #fff; padding: 1px 6px;
      border-radius: 8px; font-size: 11px; margin-left: 4px;
    }

    .sjtu-tk-tab-pane { display: none; }
    .sjtu-tk-tab-pane.active { display: block; }

    /* 全局配置 */
    .sjtu-cfg-row {
      display: flex; gap: 10px; align-items: center;
      padding: 8px 12px; background: #f5f7fa; border-radius: 6px;
      margin-bottom: 6px; font-size: 13px; flex-wrap: wrap;
    }
    .sjtu-cfg-row label { color: #555; font-weight: 600; }
    .sjtu-cfg-row input,
    .sjtu-cfg-row textarea {
      padding: 4px 8px; border: 1px solid #dcdfe6;
      border-radius: 4px; font-size: 13px;
    }
    .sjtu-cfg-row input.sm { width: 60px; }
    .sjtu-cfg-row input.md { width: 110px; }
    .sjtu-cfg-row input.lg { width: 240px; }
    .sjtu-cfg-row .end-display {
      color: #67C23A; font-weight: 600; font-size: 12px;
    }
    .sjtu-cfg-row .apply-btn,
    .sjtu-cfg-row .util-btn {
      padding: 4px 10px; color: #fff; border: none;
      border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    .sjtu-cfg-row .apply-btn { background: #409EFF; }
    .sjtu-cfg-row .apply-btn:hover { background: #2070d8; }
    .sjtu-cfg-row .util-btn { background: #909399; margin-left: auto; }
    .sjtu-cfg-row .util-btn:hover { background: #6c6e72; }
    .sjtu-cfg-block { margin-bottom: 12px; }

    /* 任务行卡片（创建 tab） */
    .sjtu-task-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 14px; }
    .sjtu-task-card { border: 1px solid #dcdfe6; border-radius: 8px; background: #fff; overflow: hidden; }
    .sjtu-task-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 14px; background: #f0f7ff;
      border-bottom: 1px solid #dcdfe6; cursor: pointer; user-select: none;
    }
    .sjtu-task-head .title {
      font-weight: 600; color: #409EFF; font-size: 14px;
      display: flex; align-items: center; gap: 8px;
    }
    .sjtu-task-head .badge {
      background: #409EFF; color: #fff; padding: 1px 8px;
      border-radius: 10px; font-size: 11px;
    }
    .sjtu-task-head .summary {
      flex: 1; margin-left: 12px;
      font-size: 12px; color: #666;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sjtu-task-head .actions { display: flex; gap: 6px; }
    .sjtu-icon-btn {
      width: 26px; height: 26px; border: none; border-radius: 4px;
      background: transparent; cursor: pointer; font-size: 14px;
      transition: background .15s;
    }
    .sjtu-icon-btn:hover { background: rgba(0,0,0,.08); }
    .sjtu-icon-btn.del:hover { background: rgba(245,108,108,.2); color: #F56C6C; }
    .sjtu-icon-btn.save:hover { background: rgba(64,158,255,.2); color: #409EFF; }
    .sjtu-task-body { padding: 14px; }
    .sjtu-task-body.collapsed { display: none; }

    .sjtu-fg { margin-bottom: 10px; }
    .sjtu-fg label {
      display: block; font-size: 12px; font-weight: 600;
      margin-bottom: 4px; color: #555;
    }
    .sjtu-fg input[type=text],
    .sjtu-fg input[type=date],
    .sjtu-fg input[type=time],
    .sjtu-fg select,
    .sjtu-fg textarea {
      width: 100%; padding: 6px 9px; border: 1px solid #dcdfe6;
      border-radius: 5px; font-size: 13px; outline: none;
      box-sizing: border-box; transition: border-color .2s;
    }
    .sjtu-fg textarea { font-family: inherit; resize: vertical; }
    .sjtu-fg input:focus, .sjtu-fg select:focus, .sjtu-fg textarea:focus { border-color: #409EFF; }
    .sjtu-fg-row { display: flex; gap: 10px; }
    .sjtu-fg-row > .sjtu-fg { flex: 1; }
    .sjtu-wd-group { display: flex; gap: 5px; flex-wrap: wrap; }
    .sjtu-wd {
      padding: 4px 12px; border: 1px solid #dcdfe6; border-radius: 16px;
      background: #fff; cursor: pointer; font-size: 12px;
      transition: all .2s; user-select: none;
    }
    .sjtu-wd.sel { background: #409EFF; color: #fff; border-color: #409EFF; }

    .sjtu-add-btn {
      width: 100%; padding: 10px; border: 2px dashed #c0c4cc;
      border-radius: 6px; background: #fff; color: #909399;
      cursor: pointer; font-size: 14px; transition: all .2s;
    }
    .sjtu-add-btn:hover { border-color: #409EFF; color: #409EFF; }

    .sjtu-btn-row { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
    .sjtu-btn {
      padding: 9px 18px; border: none; border-radius: 6px;
      cursor: pointer; font-size: 14px; font-weight: 600;
      transition: opacity .2s;
    }
    .sjtu-btn:hover { opacity: .85; }
    .sjtu-btn:disabled { opacity: .5; cursor: not-allowed; }
    .sjtu-bp { background: #409EFF; color: #fff; }
    .sjtu-bs { background: #67C23A; color: #fff; }
    .sjtu-bd { background: #F56C6C; color: #fff; }
    .sjtu-bn { background: #f0f0f0; color: #333; }
    .sjtu-bw { background: #E6A23C; color: #fff; }

    /* 列表与导出 tab */
    .sjtu-ex-filter {
      display: flex; gap: 10px; align-items: end;
      padding: 10px 14px; background: #fdf6ec; border-radius: 6px;
      margin-bottom: 10px; font-size: 13px; flex-wrap: wrap;
    }
    .sjtu-ex-filter .field { display: flex; flex-direction: column; gap: 4px; }
    .sjtu-ex-filter label { font-size: 12px; font-weight: 600; color: #555; }
    .sjtu-ex-filter input[type=text],
    .sjtu-ex-filter input[type=date] {
      padding: 5px 9px; border: 1px solid #dcdfe6; border-radius: 4px; font-size: 13px;
    }
    .sjtu-ex-filter .topic-input { width: 200px; }
    .sjtu-ex-filter .stat {
      margin-left: auto; font-size: 12px; color: #666; align-self: center;
    }
    .sjtu-ex-filter .stat strong { color: #E6A23C; }

    .sjtu-listbox {
      border: 1px solid #ebeef5; border-radius: 6px;
      max-height: 360px; overflow-y: auto; margin-bottom: 10px;
    }
    .sjtu-listhead {
      display: grid; grid-template-columns: 40px 110px 60px 1fr 80px 60px;
      gap: 10px; padding: 8px 12px; background: #f5f7fa;
      font-size: 12px; font-weight: 600; color: #555;
      border-bottom: 1px solid #ebeef5; position: sticky; top: 0; z-index: 1;
    }
    .sjtu-listrow {
      display: grid; grid-template-columns: 40px 110px 60px 1fr 80px 60px;
      gap: 10px; padding: 7px 12px; font-size: 13px;
      border-bottom: 1px solid #f5f7fa; align-items: center;
    }
    .sjtu-listrow:hover { background: #fafafa; }
    .sjtu-listrow.hidden { display: none; }
    .sjtu-listrow .topic { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sjtu-listrow .status { padding: 2px 6px; border-radius: 4px; font-size: 11px; text-align: center; }
    .sjtu-listrow .status.ok { background: #f0f9eb; color: #67C23A; }
    .sjtu-listrow .status.pending { background: #fdf6ec; color: #E6A23C; }
    .sjtu-listrow .status.no { background: #fef0f0; color: #F56C6C; }
    .sjtu-empty { padding: 20px; text-align: center; color: #999; font-size: 13px; }

    .sjtu-selbar {
      display: flex; gap: 8px; padding: 6px 0;
      font-size: 12px; align-items: center; flex-wrap: wrap;
    }
    .sjtu-selbar button {
      padding: 4px 10px; border: 1px solid #dcdfe6;
      border-radius: 4px; background: #fff; cursor: pointer; font-size: 12px;
    }
    .sjtu-selbar button:hover { border-color: #E6A23C; color: #E6A23C; }
    .sjtu-selbar button.preset { background: #fdf6ec; border-color: #E6A23C; color: #E6A23C; font-weight: 600; }
    .sjtu-selbar button.today { background: #f0f9eb; border-color: #67C23A; color: #67C23A; font-weight: 600; }
    .sjtu-selbar button.tomorrow { background: #ecf5ff; border-color: #409EFF; color: #409EFF; font-weight: 600; }
    .sjtu-selbar .selcount { color: #666; margin-left: auto; }
    .sjtu-selbar .selcount strong { color: #67C23A; }

    /* 模板 */
    .sjtu-template-row {
      display: flex; gap: 8px; padding: 8px 12px; background: #f5f7fa;
      border-radius: 6px; margin-bottom: 10px; font-size: 12px; align-items: center;
    }
    .sjtu-template-row textarea {
      flex: 1; padding: 4px 8px; border: 1px solid #dcdfe6;
      border-radius: 4px; font-size: 12px; font-family: monospace;
      min-height: 32px; resize: vertical;
    }
    .sjtu-template-row .hint { color: #909399; font-size: 11px; }

    /* 进度 */
    .sjtu-progress { margin-top: 12px; display: none; }
    .sjtu-progress.active { display: block; }
    .sjtu-pbar-bg {
      width: 100%; height: 18px; background: #ebeef5;
      border-radius: 9px; overflow: hidden; margin-bottom: 6px;
    }
    .sjtu-pbar {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, #409EFF, #67C23A);
      border-radius: 9px; transition: width .3s;
    }
    .sjtu-pbar.delete { background: linear-gradient(90deg, #F56C6C, #E6A23C); }
    .sjtu-ptext { font-size: 13px; color: #666; }

    .sjtu-result { margin-top: 12px; display: none; }
    .sjtu-result.active { display: block; }
    .sjtu-result textarea {
      width: 100%; height: 200px; font-size: 12px;
      border: 1px solid #dcdfe6; border-radius: 6px;
      padding: 10px; box-sizing: border-box;
      font-family: 'Consolas','Microsoft YaHei',monospace;
      resize: vertical;
    }

    .sjtu-log {
      margin-top: 10px; max-height: 140px; overflow-y: auto;
      font-size: 12px; color: #888; border: 1px solid #eee;
      border-radius: 6px; padding: 8px 12px; background: #fafafa;
      display: none;
    }
    .sjtu-log.active { display: block; }

    /* 预设面板 */
    .sjtu-preset-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
    .sjtu-preset-card {
      display: grid; grid-template-columns: auto 1fr auto;
      gap: 10px; align-items: center;
      padding: 10px 14px; border: 1px solid #dcdfe6;
      border-radius: 6px; background: #fafafa;
    }
    .sjtu-preset-card .pcheck { display: flex; align-items: center; }
    .sjtu-preset-card .pinfo { min-width: 0; }
    .sjtu-preset-card .pname {
      font-weight: 600; color: #409EFF; font-size: 14px;
      margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sjtu-preset-card .psum {
      font-size: 12px; color: #666;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sjtu-preset-card .pnote {
      font-size: 11px; color: #999; margin-top: 2px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sjtu-preset-card .pact { display: flex; gap: 4px; }
    .sjtu-preset-card .pact button {
      padding: 4px 10px; border: 1px solid #dcdfe6;
      background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    .sjtu-preset-card .pact button:hover { border-color: #409EFF; color: #409EFF; }
    .sjtu-preset-card .pact button.del:hover { border-color: #F56C6C; color: #F56C6C; }

    /* 预设选择弹层（导出 tab 用） */
    .sjtu-pp-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
    .sjtu-pp-item {
      padding: 8px 12px; border: 1px solid #dcdfe6; border-radius: 6px;
      cursor: pointer; transition: all .15s;
    }
    .sjtu-pp-item:hover { border-color: #E6A23C; background: #fdf6ec; }
    .sjtu-pp-item .pn { font-weight: 600; color: #E6A23C; font-size: 14px; }
    .sjtu-pp-item .ps { font-size: 12px; color: #666; margin-top: 3px; }
    .sjtu-pp-item .pmatch {
      display: inline-block; margin-left: 8px;
      background: #67C23A; color: #fff; padding: 1px 6px;
      border-radius: 8px; font-size: 11px; font-weight: 600;
    }

    /* 会议组 */
    /* tag chips */
    .sjtu-tag-bar {
      display: flex; gap: 6px; flex-wrap: wrap;
      padding: 10px 12px; background: #f5f7fa;
      border-radius: 6px; margin-bottom: 12px; align-items: center;
    }
    .sjtu-tag-bar .label { font-size: 12px; font-weight: 600; color: #555; margin-right: 4px; }
    .sjtu-tag-chip {
      padding: 3px 12px; border-radius: 14px;
      background: #fff; border: 1px solid #dcdfe6;
      cursor: pointer; font-size: 12px; user-select: none;
      transition: all .15s;
    }
    .sjtu-tag-chip:hover { border-color: #409EFF; color: #409EFF; }
    .sjtu-tag-chip.active {
      background: #409EFF; color: #fff; border-color: #409EFF;
    }
    .sjtu-tag-chip .cnt {
      margin-left: 4px; opacity: 0.7; font-size: 11px;
    }
    .sjtu-tag-load-btn {
      margin-left: auto; padding: 4px 12px;
      background: #67C23A; color: #fff; border: none; border-radius: 4px;
      cursor: pointer; font-size: 12px; font-weight: 600;
    }
    .sjtu-tag-load-btn:hover { opacity: .85; }
    .sjtu-tag-load-btn:disabled { opacity: .4; cursor: not-allowed; }
    .sjtu-preset-card .tags {
      display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px;
    }
    .sjtu-preset-card .tag-pill {
      padding: 1px 8px; background: #ecf5ff; color: #409EFF;
      border-radius: 8px; font-size: 11px;
    }

    .sjtu-group-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
    .sjtu-group-card {
      padding: 10px 14px; border: 1px solid #dcdfe6;
      border-radius: 6px; background: #fafafa;
    }
    .sjtu-group-card .gn { font-weight: 600; color: #67C23A; font-size: 14px; }
    .sjtu-group-card .gs { font-size: 12px; color: #666; margin-top: 3px; }
    .sjtu-group-card .gnote { font-size: 11px; color: #999; margin-top: 2px; }
    .sjtu-group-card .gact { display: flex; gap: 4px; margin-top: 8px; }
    .sjtu-group-card .gact button {
      padding: 4px 10px; border: 1px solid #dcdfe6;
      background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    .sjtu-group-card .gact button.load:hover { border-color: #67C23A; color: #67C23A; }
    .sjtu-group-card .gact button.del:hover { border-color: #F56C6C; color: #F56C6C; }

    /* 回收站 */
    .sjtu-recycle-list {
      max-height: 400px; overflow-y: auto;
      border: 1px solid #ebeef5; border-radius: 6px;
    }
    .sjtu-recycle-item {
      padding: 8px 14px; border-bottom: 1px solid #f5f7fa; font-size: 13px;
    }
    .sjtu-recycle-item:last-child { border-bottom: none; }
    .sjtu-recycle-item .ri-head {
      display: flex; gap: 10px; align-items: center;
    }
    .sjtu-recycle-item .ri-topic { font-weight: 600; flex: 1; }
    .sjtu-recycle-item .ri-time { color: #909399; font-size: 12px; }
    .sjtu-recycle-item .ri-del { color: #F56C6C; font-size: 11px; }
    .sjtu-recycle-item details { margin-top: 4px; }
    .sjtu-recycle-item details pre {
      background: #f5f7fa; padding: 8px; border-radius: 4px;
      font-size: 11px; white-space: pre-wrap; margin: 4px 0; max-height: 200px; overflow-y: auto;
    }
  `);

  // ========== 主面板 DOM ==========

  const fab = el('button', {
    id: 'sjtu-tk-fab',
    title: 'SJTU 云视频会议工具箱',
    textContent: '🎯',
    onclick: () => {
      mainOverlay.classList.add('active');
      if (currentTab === 'export') doScan();
    },
  });
  document.body.appendChild(fab);

  // 全局配置 inputs
  const rangeStartInput = el('input', { type: 'date', className: 'md' });
  const rangeWeeksInput = el('input', { type: 'number', className: 'sm', min: 1, max: 52, value: '4' });
  const rangeEndDisplay = el('span', { className: 'end-display' });
  const defaultPwdInput = el('input', { type: 'text', className: 'sm', maxLength: 6, placeholder: '000000' });
  const defaultCohostInput = el('input', { type: 'text', className: 'lg', placeholder: '联席 jAccount，逗号分隔' });
  const delayInput = el('input', { type: 'text', className: 'sm', placeholder: '3' });
  const applyDateToRowsBtn = el('button', { className: 'apply-btn', textContent: '应用到所有任务行' });
  const applyDefaultsToPresetsBtn = el('button', { className: 'apply-btn', textContent: '批量补到所有预设' });
  const openRecycleBtn = el('button', { className: 'util-btn', textContent: '🗑 回收站' });

  // tabs
  const tabCreate = el('div', { className: 'sjtu-tk-tab active', dataset: { tab: 'create' }, textContent: '📅 批量创建' });
  const tabExport = el('div', { className: 'sjtu-tk-tab', dataset: { tab: 'export' }, textContent: '📋 列表与导出' });
  const tabPresets = el('div', { className: 'sjtu-tk-tab', dataset: { tab: 'presets' }, textContent: '📦 预设 / 会议组' });

  // tab panes
  const paneCreate = el('div', { className: 'sjtu-tk-tab-pane active', dataset: { pane: 'create' } });
  const paneExport = el('div', { className: 'sjtu-tk-tab-pane', dataset: { pane: 'export' } });
  const panePresets = el('div', { className: 'sjtu-tk-tab-pane', dataset: { pane: 'presets' } });

  // ============================
  // Tab 1: 批量创建
  // ============================
  const taskListBox = el('div', { className: 'sjtu-task-list' });
  const addBtn = el('button', { className: 'sjtu-add-btn', textContent: '+ 添加任务（不同主题/不同时段）' });
  const previewBtn = el('button', { className: 'sjtu-btn sjtu-bn', textContent: '预览全部日期' });
  const saveCfgBtn = el('button', { className: 'sjtu-btn sjtu-bp', textContent: '保存当前任务列表' });
  const goCreateBtn = el('button', { className: 'sjtu-btn sjtu-bs', textContent: '开始批量创建' });
  const stopCreateBtn = el('button', { className: 'sjtu-btn sjtu-bd', textContent: '取消', style: { display: 'none' } });
  const previewBox = el('div', { className: 'sjtu-result' });
  const createPbar = el('div', { className: 'sjtu-pbar' });
  const createPtext = el('div', { className: 'sjtu-ptext' });
  const createLog = el('div', { className: 'sjtu-log' });

  paneCreate.appendChild(taskListBox);
  paneCreate.appendChild(addBtn);
  paneCreate.appendChild(el('div', { className: 'sjtu-btn-row' }, previewBtn, saveCfgBtn, goCreateBtn, stopCreateBtn));
  paneCreate.appendChild(previewBox);
  paneCreate.appendChild(el('div', { className: 'sjtu-progress' },
    el('div', { className: 'sjtu-pbar-bg' }, createPbar),
    createPtext
  ));
  paneCreate.appendChild(createLog);
  const createProgressBox = paneCreate.lastElementChild.previousSibling;

  // ============================
  // Tab 2: 列表与导出
  // ============================
  const topicInput = el('input', { type: 'text', className: 'topic-input', placeholder: '主题关键词（可空）' });
  const dateFromInput = el('input', { type: 'date' });
  const dateToInput = el('input', { type: 'date' });
  const statSpan = el('span', { className: 'stat' });

  const checkAll = el('input', { type: 'checkbox', title: '全选/全不选' });
  const listHead = el('div', { className: 'sjtu-listhead' },
    el('div', null, checkAll),
    el('div', null, '日期时间'),
    el('div', null, '时长'),
    el('div', null, '主题'),
    el('div', null, '状态'),
    el('div', null, '行号')
  );
  const listBox = el('div', { className: 'sjtu-listbox' });

  const selStat = el('span', { className: 'selcount' });
  const btnSelAll = el('button', { type: 'button', textContent: '可见全选' });
  const btnSelNone = el('button', { type: 'button', textContent: '清空' });
  const btnSelInvert = el('button', { type: 'button', textContent: '反选可见' });
  const btnSelByPreset = el('button', { type: 'button', className: 'preset', textContent: '📦 按预设勾选' });
  const btnSelToday = el('button', { type: 'button', className: 'today', textContent: '📅 今天' });
  const btnSelTomorrow = el('button', { type: 'button', className: 'tomorrow', textContent: '📆 明天' });
  const selBar = el('div', { className: 'sjtu-selbar' },
    btnSelAll, btnSelNone, btnSelInvert, btnSelToday, btnSelTomorrow, btnSelByPreset, selStat
  );

  // 模板
  const templateInput = el('textarea', { rows: 2, placeholder: '可选的输出模板。占位符：{topic} {time} {date} {hm} {duration} {code} {pwd} {link} {invite}\n空 = 默认 snapshot 格式' });
  const saveTemplateBtn = el('button', { type: 'button', className: 'sjtu-btn sjtu-bn', style: { padding: '4px 12px', fontSize: '12px' }, textContent: '保存模板' });
  const templateRow = el('div', { className: 'sjtu-template-row' },
    el('span', { className: 'hint' }, '🎨 模板'),
    templateInput,
    saveTemplateBtn
  );

  const exGoBtn = el('button', { className: 'sjtu-btn sjtu-bw', textContent: '提取选中', disabled: true });
  const exGoLinkBtn = el('button', { className: 'sjtu-btn sjtu-bs', textContent: '🔗 含入会链接', disabled: true, title: '含 meeting.tencent.com 链接，首次每条 ~3s，缓存后秒级' });
  const exIcsBtn = el('button', { className: 'sjtu-btn sjtu-bn', textContent: '📥 导出 ICS', disabled: true, title: '导出选中会议为 .ics 文件，导入到 Apple/Google 日历' });
  const exDelBtn = el('button', { className: 'sjtu-btn sjtu-bd', textContent: '🗑 删除选中', disabled: true });
  const exRescanBtn = el('button', { className: 'sjtu-btn sjtu-bn', textContent: '重新扫描' });
  const exStopBtn = el('button', { className: 'sjtu-btn sjtu-bd', textContent: '取消', style: { display: 'none' } });
  const exCopyBtn = el('button', { className: 'sjtu-btn sjtu-bs', textContent: '复制结果', style: { display: 'none' } });

  const exPbar = el('div', { className: 'sjtu-pbar' });
  const exPtext = el('div', { className: 'sjtu-ptext' });
  const resultArea = el('textarea', { readOnly: true });
  const exLog = el('div', { className: 'sjtu-log' });

  paneExport.appendChild(el('div', { className: 'sjtu-ex-filter' },
    el('div', { className: 'field' }, el('label', null, '主题筛选'), topicInput),
    el('div', { className: 'field' }, el('label', null, '开始日期 ≥'), dateFromInput),
    el('div', { className: 'field' }, el('label', null, '结束日期 ≤'), dateToInput),
    statSpan
  ));
  paneExport.appendChild(listHead);
  paneExport.appendChild(listBox);
  paneExport.appendChild(selBar);
  paneExport.appendChild(templateRow);
  paneExport.appendChild(el('div', { className: 'sjtu-btn-row' },
    exGoBtn, exGoLinkBtn, exIcsBtn, exDelBtn, exRescanBtn, exStopBtn, exCopyBtn
  ));
  paneExport.appendChild(el('div', { className: 'sjtu-progress' },
    el('div', { className: 'sjtu-pbar-bg' }, exPbar),
    exPtext
  ));
  const exportProgressBox = paneExport.lastElementChild;
  paneExport.appendChild(el('div', { className: 'sjtu-result' }, resultArea));
  const exportResultBox = paneExport.lastElementChild;
  paneExport.appendChild(exLog);

  // ============================
  // Tab 3: 预设 / 会议组
  // ============================
  const tagBar = el('div', { className: 'sjtu-tag-bar' });
  const tagLoadAllBtn = el('button', { className: 'sjtu-tag-load-btn', textContent: '加载该 tag 全部预设', disabled: true });
  const presetListBox = el('div', { className: 'sjtu-preset-list' });
  const presetLoadSelBtn = el('button', { className: 'sjtu-btn sjtu-bp', textContent: '加载选中（追加为新行）', disabled: true });

  panePresets.appendChild(el('div', { className: 'sjtu-tk-h' },
    el('h3', null, '📦 预设库'),
    el('span', { className: 'sub' }, '点击 tag 筛选；编辑预设可以打 tag。一键加载该 tag 全部预设到任务列表。')
  ));
  panePresets.appendChild(tagBar);
  panePresets.appendChild(presetListBox);
  panePresets.appendChild(el('div', { className: 'sjtu-btn-row' }, presetLoadSelBtn, tagLoadAllBtn));

  // 主面板
  const tabBar = el('div', { className: 'sjtu-tk-tabs' }, tabCreate, tabExport, tabPresets);
  const closeBtn = el('button', { className: 'sjtu-btn sjtu-bn', textContent: '关闭', style: { marginTop: '14px' } });
  const mainPanel = el('div', { className: 'sjtu-tk-panel' },
    el('div', { className: 'sjtu-tk-h' },
      el('span', null,
        '🎯 SJTU 云视频会议工具箱 ',
        el('span', { className: 'sub' }, 'v3.0')
      ),
      el('span', { className: 'sub' }, '创建 / 提取 / 删除 / 预设 一站式')
    ),
    // 全局配置区
    el('div', { className: 'sjtu-cfg-block' },
      el('div', { className: 'sjtu-cfg-row' },
        el('label', null, '📅 学期范围'),
        el('span', null, '起点'),
        rangeStartInput,
        el('span', null, '× 周数'),
        rangeWeeksInput,
        rangeEndDisplay,
        applyDateToRowsBtn
      ),
      el('div', { className: 'sjtu-cfg-row' },
        el('label', null, '🔑 默认'),
        el('span', null, '密码'),
        defaultPwdInput,
        el('span', null, '联席'),
        defaultCohostInput,
        applyDefaultsToPresetsBtn
      ),
      el('div', { className: 'sjtu-cfg-row' },
        el('label', null, '操作间隔（秒）'),
        delayInput,
        el('span', { style: { color: '#999', fontSize: '12px' } }, '提交后等待秒数'),
        openRecycleBtn
      )
    ),
    tabBar,
    paneCreate,
    paneExport,
    panePresets,
    el('div', { className: 'sjtu-btn-row' }, closeBtn)
  );

  const mainOverlay = el('div', {
    id: 'sjtu-tk-overlay-main',
    className: 'sjtu-tk-overlay',
    onclick: e => { if (e.target === mainOverlay) mainOverlay.classList.remove('active'); },
  }, mainPanel);
  document.body.appendChild(mainOverlay);

  // tab 切换
  function setTab(name) {
    currentTab = name;
    [tabCreate, tabExport, tabPresets].forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    [paneCreate, paneExport, panePresets].forEach(p => p.classList.toggle('active', p.dataset.pane === name));
    if (name === 'export') doScan();
    if (name === 'presets') { renderPresets(); }
  }
  [tabCreate, tabExport, tabPresets].forEach(t => t.onclick = () => setTab(t.dataset.tab));

  closeBtn.onclick = () => mainOverlay.classList.remove('active');

  // ========== 编辑预设 overlay ==========
  const epName = el('input', { type: 'text' });
  const epTopic = el('input', { type: 'text' });
  const epPwd = el('input', { type: 'text', maxLength: 6, placeholder: '000000' });
  const epCohost = el('input', { type: 'text', placeholder: '逗号分隔' });
  const epTime = el('input', { type: 'time' });
  const epDur = el('select', null);
  DURATION_OPTIONS.forEach(t => epDur.appendChild(el('option', { value: t }, t)));
  const epNote = el('textarea', { rows: 2 });
  const epTags = el('input', { type: 'text', placeholder: '逗号分隔，例如：本学期, 组会, 周三' });
  const epWdBox = el('div', { className: 'sjtu-wd-group' });
  const epWdState = [];
  WEEKDAY_NAMES.forEach((n, i) => {
    const s = el('span', { className: 'sjtu-wd', textContent: n, dataset: { d: String(i) } });
    s.onclick = () => { epWdState[i] = !epWdState[i]; s.classList.toggle('sel', epWdState[i]); };
    epWdBox.appendChild(s);
  });
  function setWdState(arr) {
    for (let i = 0; i < 7; i++) epWdState[i] = arr.includes(i);
    Array.from(epWdBox.children).forEach((s, i) => s.classList.toggle('sel', epWdState[i]));
  }
  function getWdSelected() { const o = []; for (let i = 0; i < 7; i++) if (epWdState[i]) o.push(i); return o; }

  const epSaveBtn = el('button', { className: 'sjtu-btn sjtu-bp', textContent: '保存' });
  const epCancelBtn = el('button', { className: 'sjtu-btn sjtu-bn', textContent: '取消' });
  const editPanel = el('div', { className: 'sjtu-tk-panel sm' },
    el('div', { className: 'sjtu-tk-h' }, el('h3', null, '编辑预设')),
    el('div', { className: 'sjtu-fg' }, el('label', null, '预设名称 *'), epName),
    el('div', { className: 'sjtu-fg' }, el('label', null, '会议主题 *'), epTopic),
    el('div', { className: 'sjtu-fg-row' },
      el('div', { className: 'sjtu-fg' }, el('label', null, '密码（可空）'), epPwd),
      el('div', { className: 'sjtu-fg' }, el('label', null, '联席（可空）'), epCohost)
    ),
    el('div', { className: 'sjtu-fg' }, el('label', null, '重复星期 *（点击多选）'), epWdBox),
    el('div', { className: 'sjtu-fg-row' },
      el('div', { className: 'sjtu-fg' }, el('label', null, '时间 *'), epTime),
      el('div', { className: 'sjtu-fg' }, el('label', null, '时长 *'), epDur)
    ),
    el('div', { className: 'sjtu-fg' }, el('label', null, '🏷 标签 tags（多个用逗号分隔；可空）'), epTags),
    el('div', { className: 'sjtu-fg' }, el('label', null, '备注（可空）'), epNote),
    el('div', { className: 'sjtu-btn-row' }, epSaveBtn, epCancelBtn)
  );
  const editOverlay = el('div', {
    id: 'sjtu-tk-overlay-edit', className: 'sjtu-tk-overlay',
    onclick: e => { if (e.target === editOverlay) editOverlay.classList.remove('active'); },
  }, editPanel);
  document.body.appendChild(editOverlay);

  function openEditPreset(p) {
    editingPresetRef = p;
    epName.value = p.name || '';
    epTopic.value = p.topic || '';
    epPwd.value = p.password || '';
    epCohost.value = p.cohost || '';
    epTime.value = p.time || '09:00';
    epDur.value = DURATION_OPTIONS.includes(p.duration) ? p.duration : '3小时';
    epNote.value = p.note || '';
    epTags.value = (p.tags || []).join(', ');
    setWdState(p.weekdays || []);
    editOverlay.classList.add('active');
    setTimeout(() => epName.focus(), 50);
  }
  epCancelBtn.onclick = () => editOverlay.classList.remove('active');
  epSaveBtn.onclick = () => {
    if (!editingPresetRef) return;
    const name = epName.value.trim();
    if (!name) return alert('名称不能为空');
    const topic = epTopic.value.trim();
    if (!topic) return alert('主题不能为空');
    const wds = getWdSelected();
    if (!wds.length) return alert('至少选一个星期');
    if (!/^\d{1,2}:\d{2}$/.test(epTime.value)) return alert('时间格式错误');
    if (!DURATION_OPTIONS.includes(epDur.value)) return alert('时长不合法');
    const tags = epTags.value.split(',').map(s => s.trim()).filter(Boolean);
    Object.assign(editingPresetRef, {
      name, topic,
      password: epPwd.value.trim(),
      cohost: epCohost.value.trim(),
      weekdays: wds,
      time: epTime.value,
      duration: epDur.value,
      note: epNote.value,
      tags,
      updatedAt: new Date().toISOString(),
    });
    savePresets();
    renderPresets();
    log(`✓ 预设「${name}」已更新${tags.length ? '（标签 ' + tags.join('/') + '）' : ''}`);
    editOverlay.classList.remove('active');
    editingPresetRef = null;
  };

  // ========== 预设选择弹层（用于"按预设勾选"按钮） ==========
  const presetPickList = el('div', { className: 'sjtu-pp-list' });
  const presetPickPanel = el('div', { className: 'sjtu-tk-panel sm' },
    el('div', { className: 'sjtu-tk-h' }, el('h3', null, '📦 选预设自动勾选匹配会议')),
    el('p', { style: { fontSize: '12px', color: '#888', margin: '0 0 10px' } }, '匹配规则：主题包含 + 星期一致 + 开始时间相同。点击直接累加勾选。'),
    presetPickList,
    el('div', { className: 'sjtu-btn-row' },
      el('button', { className: 'sjtu-btn sjtu-bn', textContent: '关闭', onclick: () => presetPickOverlay.classList.remove('active') })
    )
  );
  const presetPickOverlay = el('div', {
    id: 'sjtu-tk-overlay-preset-pick', className: 'sjtu-tk-overlay',
    onclick: e => { if (e.target === presetPickOverlay) presetPickOverlay.classList.remove('active'); },
  }, presetPickPanel);
  document.body.appendChild(presetPickOverlay);

  // ========== 回收站 overlay ==========
  const recycleListBox = el('div', { className: 'sjtu-recycle-list' });
  const recycleClearBtn = el('button', { className: 'sjtu-btn sjtu-bd', textContent: '清空回收站' });
  const recyclePanel = el('div', { className: 'sjtu-tk-panel md' },
    el('div', { className: 'sjtu-tk-h' },
      el('h3', null, '🗑 回收站'),
      el('span', { className: 'sub' }, '保留删除会议的完整信息（含入会链接缓存）')
    ),
    recycleListBox,
    el('div', { className: 'sjtu-btn-row' },
      recycleClearBtn,
      el('button', { className: 'sjtu-btn sjtu-bn', textContent: '关闭', onclick: () => recycleOverlay.classList.remove('active') })
    )
  );
  const recycleOverlay = el('div', {
    id: 'sjtu-tk-overlay-recycle', className: 'sjtu-tk-overlay',
    onclick: e => { if (e.target === recycleOverlay) recycleOverlay.classList.remove('active'); },
  }, recyclePanel);
  document.body.appendChild(recycleOverlay);

  function renderRecycle() {
    clearChildren(recycleListBox);
    const bin = lsLoad(LS.recycleBin, []);
    if (!bin.length) {
      recycleListBox.appendChild(el('div', { className: 'sjtu-empty' }, '回收站为空'));
      return;
    }
    bin.forEach(it => {
      const card = el('div', { className: 'sjtu-recycle-item' },
        el('div', { className: 'ri-head' },
          el('span', { className: 'ri-topic' }, it.topic || '（无主题）'),
          el('span', { className: 'ri-time' }, it.time),
          el('span', { className: 'ri-del' }, '删于 ' + (it.deletedAt || '').slice(0, 16).replace('T', ' '))
        ),
        el('details', null,
          el('summary', { style: { fontSize: '11px', color: '#909399', cursor: 'pointer' } }, '展开邀请详情'),
          el('pre', null, it.invite || `（无入会链接缓存）\n会议号：${it.id}\n时长：${it.duration}\n${it.codePwd || ''}`)
        )
      );
      recycleListBox.appendChild(card);
    });
  }
  openRecycleBtn.onclick = () => { renderRecycle(); recycleOverlay.classList.add('active'); };
  recycleClearBtn.onclick = () => {
    if (!confirm('确认清空回收站？此操作不可恢复。')) return;
    lsDel(LS.recycleBin);
    renderRecycle();
    log('回收站已清空');
  };

  function archiveToRecycleBin(targets) {
    const bin = lsLoad(LS.recycleBin, []);
    const cache = getInviteCache();
    targets.forEach(m => {
      bin.unshift({
        id: m.id, time: m.time, duration: m.duration, topic: m.topic,
        codePwd: m.codePwd,
        invite: cache[m.id] ? cache[m.id].invite : null,
        deletedAt: new Date().toISOString(),
      });
    });
    // 限制最多 200 条
    if (bin.length > 200) bin.length = 200;
    lsSave(LS.recycleBin, bin);
  }

  // ========== 持久化 helpers ==========
  function loadAll() {
    Object.assign(globals, lsLoad(LS.globals, {}));
    presets = lsLoad(LS.presets, []);
    groups = lsLoad(LS.groups, []);
    const cfg = lsLoad(LS.rows, null);
    if (cfg && cfg.rows && cfg.rows.length) {
      rows = cfg.rows.map(r => ({ ...defaultRow(), ...r, id: uid() }));
    }
    if (!rows.length) rows = [defaultRow()];
  }
  function saveGlobals() { lsSave(LS.globals, globals); }
  function savePresets() { lsSave(LS.presets, presets); }
  function saveGroups() { lsSave(LS.groups, groups); }
  function saveCurrentRows() { lsSave(LS.rows, { rows }); }

  // ========== 全局配置 sync ==========
  function syncGlobalsToUI() {
    rangeStartInput.value = globals.rangeStart || todayStr();
    rangeWeeksInput.value = globals.rangeWeeks || 4;
    rangeEndDisplay.textContent = '截止：' + rangeEndDate();
    defaultPwdInput.value = globals.defaultPassword || '';
    defaultCohostInput.value = globals.defaultCohost || '';
    delayInput.value = globals.delaySeconds || 3;
    templateInput.value = globals.outputTemplate || '';
  }
  function syncUIToGlobals() {
    globals.rangeStart = rangeStartInput.value || '';
    const w = parseInt(rangeWeeksInput.value, 10);
    globals.rangeWeeks = (isNaN(w) || w < 1) ? 4 : Math.min(w, 52);
    globals.defaultPassword = defaultPwdInput.value || '';
    globals.defaultCohost = defaultCohostInput.value || '';
    globals.delaySeconds = parseInt(delayInput.value, 10) || 3;
    rangeEndDisplay.textContent = '截止：' + rangeEndDate();
    saveGlobals();
  }
  rangeStartInput.addEventListener('change', syncUIToGlobals);
  rangeWeeksInput.addEventListener('input', syncUIToGlobals);
  defaultPwdInput.addEventListener('input', syncUIToGlobals);
  defaultCohostInput.addEventListener('input', syncUIToGlobals);
  delayInput.addEventListener('input', syncUIToGlobals);

  applyDateToRowsBtn.onclick = () => {
    syncUIToGlobals();
    const s = rangeStartDate(), e = rangeEndDate();
    rows.forEach(r => { r.startDate = s; r.endDate = e; });
    renderRows();
    log(`📅 已把 ${s} → ${e} 应用到 ${rows.length} 个任务行`);
  };
  applyDefaultsToPresetsBtn.onclick = () => {
    syncUIToGlobals();
    const mode = prompt(
      `选择补值模式（${presets.length} 个预设）:\n` +
      `  "1" = 仅补空字段（已有联席/密码不动）\n` +
      `  "2" = 全部覆盖（连已有的也改）\n\n` +
      `默认密码: 「${globals.defaultPassword || '（空）'}」\n` +
      `默认联席: 「${globals.defaultCohost || '（空）'}」`,
      '1'
    );
    if (mode !== '1' && mode !== '2') return;
    const overwrite = mode === '2';
    if (overwrite && !confirm('⚠️ 模式 2 会覆盖所有预设的密码 + 联席（即使非空）。确认？')) return;

    let n = 0;
    presets.forEach(p => {
      let changed = false;
      if (globals.defaultPassword && (overwrite || !p.password)) {
        if (p.password !== globals.defaultPassword) { p.password = globals.defaultPassword; changed = true; }
      }
      if (globals.defaultCohost && (overwrite || !p.cohost)) {
        if (p.cohost !== globals.defaultCohost) { p.cohost = globals.defaultCohost; changed = true; }
      }
      if (changed) { p.updatedAt = new Date().toISOString(); n++; }
    });
    if (n) savePresets();
    log(`✓ 已把默认配置（${overwrite ? '覆盖' : '仅补空'}）应用到 ${n} 个预设`);
  };

  saveTemplateBtn.onclick = () => {
    globals.outputTemplate = templateInput.value;
    saveGlobals();
    alert('模板已保存');
  };

  // ========== 日志 ==========
  function log(msg) {
    const target = currentTab === 'export' ? exLog : createLog;
    target.classList.add('active');
    target.appendChild(el('div', null, `[${new Date().toLocaleTimeString()}] ${msg}`));
    target.scrollTop = target.scrollHeight;
    console.log('[SJTU TK]', msg);
  }

  // ========== 任务行渲染（创建 tab） ==========
  function renderRows() {
    clearChildren(taskListBox);
    rows.forEach((row, idx) => taskListBox.appendChild(buildRowCard(row, idx)));
  }
  function buildRowCard(row, idx) {
    const titleSpan = el('span', null, row.topic || '未命名任务');
    const summaryEl = el('div', { className: 'summary', textContent: buildRowSummary(row) });

    const presetSaveBtn = el('button', { className: 'sjtu-icon-btn save', title: '保存为预设', textContent: '💾' });
    const dupBtn = el('button', { className: 'sjtu-icon-btn', title: '复制此行', textContent: '⎘' });
    const delBtn = el('button', { className: 'sjtu-icon-btn del', title: '删除此行', textContent: '✕' });
    const togBtn = el('button', { className: 'sjtu-icon-btn', title: '折叠/展开', textContent: row.collapsed ? '▼' : '▲' });

    presetSaveBtn.onclick = e => { e.stopPropagation(); saveRowAsPreset(row); };
    dupBtn.onclick = e => {
      e.stopPropagation();
      const c = JSON.parse(JSON.stringify(row));
      c.id = uid(); c.collapsed = false;
      rows.splice(idx + 1, 0, c);
      renderRows();
    };
    delBtn.onclick = e => {
      e.stopPropagation();
      if (rows.length <= 1) return alert('至少保留一行');
      if (!confirm(`删除任务 #${idx + 1}「${row.topic || '未命名'}」？`)) return;
      rows.splice(idx, 1);
      renderRows();
    };
    togBtn.onclick = e => { e.stopPropagation(); row.collapsed = !row.collapsed; renderRows(); };

    const head = el('div', {
      className: 'sjtu-task-head',
      onclick: () => { row.collapsed = !row.collapsed; renderRows(); },
    },
      el('div', { className: 'title' },
        el('span', { className: 'badge' }, '#' + (idx + 1)),
        titleSpan
      ),
      summaryEl,
      el('div', { className: 'actions' }, presetSaveBtn, dupBtn, delBtn, togBtn)
    );

    const topicI = el('input', { type: 'text', placeholder: '例如：组会 / 应用统计课', value: row.topic });
    const pwdI = el('input', { type: 'text', maxLength: 6, placeholder: '000000', value: row.password });
    const cohostI = el('input', { type: 'text', placeholder: 'zhangsan', value: row.cohost });
    const sdI = el('input', { type: 'date', value: row.startDate });
    const edI = el('input', { type: 'date', value: row.endDate });
    const timeI = el('input', { type: 'time', value: row.time });
    const durSel = el('select', null);
    DURATION_OPTIONS.forEach(t => durSel.appendChild(el('option', { value: t }, t)));
    durSel.value = row.duration;

    const wdBox = el('div', { className: 'sjtu-wd-group' });
    WEEKDAY_NAMES.forEach((n, i) => {
      const s = el('span', {
        className: 'sjtu-wd' + (row.weekdays.includes(i) ? ' sel' : ''),
        textContent: n, dataset: { d: String(i) },
      });
      s.onclick = () => {
        s.classList.toggle('sel');
        const di = +s.dataset.d;
        if (s.classList.contains('sel')) {
          if (!row.weekdays.includes(di)) row.weekdays.push(di);
        } else { row.weekdays = row.weekdays.filter(d => d !== di); }
        refreshHead();
      };
      wdBox.appendChild(s);
    });

    function refreshHead() {
      titleSpan.textContent = row.topic || '未命名任务';
      summaryEl.textContent = buildRowSummary(row);
    }
    function bind(input, fieldName) {
      input.addEventListener('input', () => { row[fieldName] = input.value; refreshHead(); });
    }
    bind(topicI, 'topic'); bind(pwdI, 'password'); bind(cohostI, 'cohost');
    bind(sdI, 'startDate'); bind(edI, 'endDate'); bind(timeI, 'time');
    durSel.addEventListener('change', () => { row.duration = durSel.value; refreshHead(); });

    const body = el('div', { className: 'sjtu-task-body' + (row.collapsed ? ' collapsed' : '') },
      el('div', { className: 'sjtu-fg' }, el('label', null, '主题 *'), topicI),
      el('div', { className: 'sjtu-fg-row' },
        el('div', { className: 'sjtu-fg' }, el('label', null, '密码（6位，可空）'), pwdI),
        el('div', { className: 'sjtu-fg' }, el('label', null, '联席 jAccount（可空）'), cohostI)
      ),
      el('div', { className: 'sjtu-fg-row' },
        el('div', { className: 'sjtu-fg' }, el('label', null, '开始日期 *'), sdI),
        el('div', { className: 'sjtu-fg' }, el('label', null, '结束日期 *'), edI)
      ),
      el('div', { className: 'sjtu-fg' }, el('label', null, '重复星期 *'), wdBox),
      el('div', { className: 'sjtu-fg-row' },
        el('div', { className: 'sjtu-fg' }, el('label', null, '时间 *'), timeI),
        el('div', { className: 'sjtu-fg' }, el('label', null, '时长 *'), durSel)
      )
    );
    return el('div', { className: 'sjtu-task-card' }, head, body);
  }
  function buildRowSummary(row) {
    const wd = row.weekdays.length ? row.weekdays.slice().sort().map(d => WEEKDAY_NAMES[d]).join('/') : '未选星期';
    const dr = (row.startDate && row.endDate) ? `${row.startDate}→${row.endDate}` : '日期未填';
    return `${dr} · ${wd} · ${row.time} · ${row.duration}`;
  }
  addBtn.onclick = () => { rows.push(defaultRow()); renderRows(); };

  // ========== 预设管理（用于 Tab 3） ==========
  function saveRowAsPreset(row) {
    const defaultName = row.topic || `预设 ${presets.length + 1}`;
    const name = prompt('预设名称：', defaultName);
    if (!name) return;
    const tagRaw = prompt('🏷 标签 tags（多个用逗号分隔，可空）：', '') || '';
    const tags = tagRaw.split(',').map(s => s.trim()).filter(Boolean);
    const note = prompt('备注（可空）：', '') || '';
    const fields = {
      note, topic: row.topic,
      password: row.password || globals.defaultPassword,
      cohost: row.cohost || globals.defaultCohost,
      weekdays: row.weekdays.slice(),
      time: row.time, duration: row.duration,
      tags,
      updatedAt: new Date().toISOString(),
    };
    const existing = presets.find(p => p.name === name);
    if (existing) {
      if (confirm(`同名预设已存在，覆盖？`)) {
        Object.assign(existing, fields);
        savePresets();
        log(`✓ 更新预设「${name}」`);
        return;
      }
    }
    presets.unshift({ id: uid(), name, ...fields, createdAt: new Date().toISOString() });
    savePresets();
    log(`✓ 保存预设「${name}」${tags.length ? '（标签 ' + tags.join('/') + '）' : ''}`);
  }

  function buildPresetSummary(p) {
    const wd = (p.weekdays || []).length ? p.weekdays.slice().sort().map(d => WEEKDAY_NAMES[d]).join('/') : '未选星期';
    const parts = [p.topic || '（无主题）', wd, p.time, p.duration];
    if (p.cohost) parts.push('联席:' + p.cohost);
    if (p.password) parts.push('密码:' + p.password);
    return parts.join(' · ');
  }

  function getAllTags() {
    const set = new Set();
    presets.forEach(p => (p.tags || []).forEach(t => { if (t) set.add(t); }));
    return Array.from(set);
  }
  function presetMatchesTagFilter(p) {
    if (!activeTagFilter) return true;
    return (p.tags || []).includes(activeTagFilter);
  }
  function renderTagBar() {
    clearChildren(tagBar);
    tagBar.appendChild(el('span', { className: 'label' }, '🏷 筛选'));
    const allChip = el('div', {
      className: 'sjtu-tag-chip' + (activeTagFilter === '' ? ' active' : ''),
      onclick: () => { activeTagFilter = ''; renderTagBar(); renderPresets(); },
    }, '全部 ', el('span', { className: 'cnt' }, String(presets.length)));
    tagBar.appendChild(allChip);
    const tags = getAllTags().sort();
    tags.forEach(t => {
      const cnt = presets.filter(p => (p.tags || []).includes(t)).length;
      const chip = el('div', {
        className: 'sjtu-tag-chip' + (activeTagFilter === t ? ' active' : ''),
        onclick: () => { activeTagFilter = t; renderTagBar(); renderPresets(); },
      }, t, el('span', { className: 'cnt' }, '(' + cnt + ')'));
      tagBar.appendChild(chip);
    });
    if (!tags.length) {
      tagBar.appendChild(el('span', { style: { fontSize: '12px', color: '#909399' } }, '（还没有标签：编辑预设可加 tags）'));
    }
    // 加载该 tag 全部按钮
    const filtered = presets.filter(presetMatchesTagFilter);
    tagLoadAllBtn.disabled = !filtered.length;
    tagLoadAllBtn.textContent = activeTagFilter
      ? `加载「${activeTagFilter}」全部 ${filtered.length} 个预设`
      : `加载全部 ${filtered.length} 个预设`;
  }

  function renderPresets() {
    renderTagBar();
    clearChildren(presetListBox);
    const filtered = presets.filter(presetMatchesTagFilter);
    if (!filtered.length) {
      presetListBox.appendChild(el('div', { className: 'sjtu-empty' }, presets.length ? `当前 tag「${activeTagFilter}」下没有预设` : '还没有预设。在创建 tab 任务行点 💾 保存。'));
      presetLoadSelBtn.disabled = true;
      return;
    }
    filtered.forEach(p => presetListBox.appendChild(buildPresetCard(p)));
    updatePresetSelStat();
  }
  tagLoadAllBtn.onclick = () => {
    const filtered = presets.filter(presetMatchesTagFilter);
    if (!filtered.length) return;
    if (!confirm(`把 ${activeTagFilter ? '"' + activeTagFilter + '" tag 下' : '全部'} ${filtered.length} 个预设加载为新任务行？`)) return;
    filtered.forEach(p => loadPresetIntoRows(p));
    log(`+ 加载 ${activeTagFilter || '全部'} 共 ${filtered.length} 个预设到任务列表`);
    setTab('create');
  };
  function buildPresetCard(p) {
    const cb = el('input', { type: 'checkbox', onchange: updatePresetSelStat });
    const editBtn = el('button', { type: 'button', textContent: '编辑', onclick: () => openEditPreset(p) });
    const loadBtn = el('button', { type: 'button', textContent: '加载', onclick: () => { loadPresetIntoRows(p); log(`+ 加载预设「${p.name}」一行`); setTab('create'); } });
    const delBtn = el('button', { type: 'button', className: 'del', textContent: '删除', onclick: () => {
      if (!confirm(`删除预设「${p.name}」？`)) return;
      presets = presets.filter(x => x.id !== p.id);
      savePresets();
      renderPresets();
    }});

    // tag chips
    let tagsBox = null;
    if (p.tags && p.tags.length) {
      tagsBox = el('div', { className: 'tags' });
      p.tags.forEach(t => {
        const pill = el('span', { className: 'tag-pill', onclick: e => { e.stopPropagation(); activeTagFilter = t; renderTagBar(); renderPresets(); } }, t);
        tagsBox.appendChild(pill);
      });
    }

    return el('div', { className: 'sjtu-preset-card', dataset: { id: p.id } },
      el('div', { className: 'pcheck' }, cb),
      el('div', { className: 'pinfo' },
        el('div', { className: 'pname' }, p.name),
        el('div', { className: 'psum' }, buildPresetSummary(p)),
        tagsBox,
        p.note ? el('div', { className: 'pnote' }, '备注：' + p.note) : null
      ),
      el('div', { className: 'pact' }, loadBtn, editBtn, delBtn)
    );
  }
  function updatePresetSelStat() {
    const checked = presetListBox.querySelectorAll('input[type=checkbox]:checked').length;
    presetLoadSelBtn.disabled = checked === 0;
    presetLoadSelBtn.textContent = checked ? `加载选中 ${checked} 个（追加为新行）` : '加载选中（追加为新行）';
  }
  presetLoadSelBtn.onclick = () => {
    const cards = presetListBox.querySelectorAll('.sjtu-preset-card');
    let cnt = 0;
    cards.forEach(card => {
      const cb = card.querySelector('input[type=checkbox]');
      if (cb && cb.checked) {
        const p = presets.find(x => x.id === card.dataset.id);
        if (p) { loadPresetIntoRows(p); cnt++; }
      }
    });
    log(`+ 从预设库加载 ${cnt} 行`);
    if (cnt) setTab('create');
  };
  function loadPresetIntoRows(p) {
    rows.push({
      ...defaultRow(),
      topic: p.topic,
      password: p.password || globals.defaultPassword,
      cohost: p.cohost || globals.defaultCohost,
      weekdays: (p.weekdays || []).slice(),
      time: p.time, duration: p.duration,
    });
    renderRows();
  }

  // ========== 扫描表格 ==========
  function classifyStatus(s) {
    if (!s) return { cls: 'pending', text: '?' };
    if (s.includes('批准')) return { cls: 'ok', text: '批准' };
    if (s.includes('待') || s.includes('审核')) return { cls: 'pending', text: '待批' };
    if (s.includes('拒') || s.includes('不通过')) return { cls: 'no', text: '拒绝' };
    return { cls: 'pending', text: s.slice(0, 4) };
  }
  function doScan() {
    const trs = document.querySelectorAll('.el-table__body tbody tr.el-table__row');
    scanned = [];
    trs.forEach((tr, i) => {
      const cells = tr.querySelectorAll('td');
      const get = idx => cells[idx] ? cells[idx].textContent.trim() : '';
      scanned.push({
        idx: i, id: get(1), time: get(2), duration: get(3),
        topic: get(4), host: get(5), status: get(8),
        codePwd: get(9), checked: false,
      });
    });
    log(`扫描到 ${scanned.length} 行`);
    renderList();
  }
  function renderList() {
    clearChildren(listBox);
    if (!scanned.length) {
      listBox.appendChild(el('div', { className: 'sjtu-empty' }, '当前页面没有会议行。请先在 my-meeting 翻到目标页再点"重新扫描"。'));
      exGoBtn.disabled = true; exGoLinkBtn.disabled = true; exDelBtn.disabled = true; exIcsBtn.disabled = true;
      return;
    }
    scanned.forEach((m, i) => {
      const cb = el('input', { type: 'checkbox', checked: m.checked, onchange: e => { m.checked = e.target.checked; updateSelStat(); } });
      const st = classifyStatus(m.status);
      const row = el('div', { className: 'sjtu-listrow', dataset: { i: String(i) } },
        cb,
        el('div', null, m.time || '—'),
        el('div', null, m.duration || '—'),
        el('div', { className: 'topic', title: m.topic }, m.topic || '（无主题）'),
        el('div', { className: 'status ' + st.cls }, st.text),
        el('div', { style: { color: '#999', fontSize: '11px' } }, '#' + (i + 1))
      );
      listBox.appendChild(row);
    });
    applyFilter();
    updateSelStat();
  }
  function applyFilter() {
    const kw = topicInput.value.trim().toLowerCase();
    const from = dateFromInput.value, to = dateToInput.value;
    let visible = 0;
    listBox.querySelectorAll('.sjtu-listrow').forEach((rowEl, i) => {
      const m = scanned[i];
      if (!m) return;
      let show = true;
      if (kw && !(m.topic || '').toLowerCase().includes(kw)) show = false;
      const dateOnly = (m.time || '').split(' ')[0];
      if (show && from && dateOnly && dateOnly < from) show = false;
      if (show && to && dateOnly && dateOnly > to) show = false;
      m.hidden = !show;
      rowEl.classList.toggle('hidden', !show);
      if (show) visible++;
    });
    clearChildren(statSpan);
    statSpan.appendChild(document.createTextNode('匹配 '));
    statSpan.appendChild(el('strong', null, String(visible)));
    statSpan.appendChild(document.createTextNode(` / 共 ${scanned.length}`));
  }
  function updateSelStat() {
    const sel = scanned.filter(m => m.checked).length;
    clearChildren(selStat);
    selStat.appendChild(document.createTextNode('已选 '));
    selStat.appendChild(el('strong', null, String(sel)));
    selStat.appendChild(document.createTextNode(` / ${scanned.length}`));
    [exGoBtn, exGoLinkBtn, exDelBtn, exIcsBtn].forEach(b => b.disabled = sel === 0);
    exGoBtn.textContent = sel ? `提取选中 (${sel})` : '提取选中';
    exGoLinkBtn.textContent = sel ? `🔗 含入会链接 (${sel})` : '🔗 含入会链接';
    exDelBtn.textContent = sel ? `🗑 删除选中 (${sel})` : '🗑 删除选中';
    exIcsBtn.textContent = sel ? `📥 导出 ICS (${sel})` : '📥 导出 ICS';
  }
  function selVisible(v) { scanned.forEach(m => { if (!m.hidden) m.checked = v; }); syncCheckboxes(); }
  function selInvert() { scanned.forEach(m => { if (!m.hidden) m.checked = !m.checked; }); syncCheckboxes(); }
  function syncCheckboxes() {
    listBox.querySelectorAll('.sjtu-listrow').forEach((rowEl, i) => {
      const cb = rowEl.querySelector('input[type=checkbox]');
      if (cb && scanned[i]) cb.checked = scanned[i].checked;
    });
    updateSelStat();
  }
  // 当天/明天勾选
  function selByDate(targetDate) {
    let added = 0;
    scanned.forEach(m => {
      if (!m.checked && (m.time || '').startsWith(targetDate)) {
        m.checked = true; added++;
      }
    });
    syncCheckboxes();
    log(`📅 勾选 ${targetDate}: 新增 ${added} 条`);
    return added;
  }

  topicInput.addEventListener('input', applyFilter);
  dateFromInput.addEventListener('change', applyFilter);
  dateToInput.addEventListener('change', applyFilter);
  btnSelAll.onclick = () => selVisible(true);
  btnSelNone.onclick = () => selVisible(false);
  btnSelInvert.onclick = selInvert;
  btnSelToday.onclick = () => selByDate(todayStr());
  btnSelTomorrow.onclick = () => selByDate(tomorrowStr());
  checkAll.onchange = () => selVisible(checkAll.checked);
  exRescanBtn.onclick = doScan;

  // 按预设勾选
  function presetMatchesMeeting(p, m) {
    if (!m || !p) return false;
    const mt = (m.topic || '').toLowerCase();
    const pt = (p.topic || '').toLowerCase().trim();
    if (pt && !mt.includes(pt)) return false;
    const dayStr = (m.time || '').split(' ')[0];
    if (dayStr && p.weekdays && p.weekdays.length) {
      const dt = new Date(dayStr + 'T00:00:00');
      if (isNaN(dt) || !p.weekdays.includes(dt.getDay())) return false;
    }
    if (p.time) {
      const mTime = (m.time || '').split(' ')[1] || '';
      if (!mTime.startsWith(p.time)) return false;
    }
    return true;
  }
  btnSelByPreset.onclick = () => {
    clearChildren(presetPickList);
    if (!presets.length) {
      presetPickList.appendChild(el('div', { className: 'sjtu-empty' }, '还没有预设。先在创建 tab 保存几个。'));
    } else {
      presets.forEach(p => {
        const cnt = scanned.filter(m => presetMatchesMeeting(p, m)).length;
        const wdStr = p.weekdays && p.weekdays.length ? p.weekdays.slice().sort().map(d => ['日','一','二','三','四','五','六'][d]).join('/') : '?';
        const item = el('div', { className: 'sjtu-pp-item' },
          el('div', { className: 'pn' },
            p.name,
            cnt > 0 ? el('span', { className: 'pmatch' }, `匹配 ${cnt}`) : null
          ),
          el('div', { className: 'ps' }, `${p.topic || ''} · 周${wdStr} · ${p.time || ''} · ${p.duration || ''}`)
        );
        item.onclick = () => {
          let added = 0;
          scanned.forEach(m => { if (!m.checked && presetMatchesMeeting(p, m)) { m.checked = true; added++; } });
          syncCheckboxes();
          log(`📦「${p.name}」: 勾选 ${added} 条`);
          presetPickOverlay.classList.remove('active');
        };
        presetPickList.appendChild(item);
      });
    }
    presetPickOverlay.classList.add('active');
  };

  // ========== 提取（snapshot 默认） ==========
  function parseCodePwd(s) {
    if (!s) return { code: '', pwd: '' };
    const m1 = s.match(/会议号[:：]?\s*(\S+?)(?:\s|密码|$)/);
    const m2 = s.match(/密码[:：]?\s*(\S+)/);
    return { code: m1 ? m1[1] : '', pwd: m2 ? m2[1] : '' };
  }
  function formatSnapshot(m) {
    const cp = parseCodePwd(m.codePwd);
    return [
      `【${m.topic || '（无主题）'}】`,
      `时间：${m.time}`,
      `时长：${m.duration}`,
      cp.code ? `会议号：${cp.code}` : '',
      cp.pwd ? `密码：${cp.pwd}` : '',
    ].filter(Boolean).join('\n');
  }
  function extractInviteLink(invite) {
    if (!invite) return '';
    const m = invite.match(/https?:\/\/meeting\.tencent\.com\/[^\s]+/);
    return m ? m[0] : '';
  }
  function applyTemplate(m, tpl) {
    const cp = parseCodePwd(m.codePwd);
    const cache = getInviteCache();
    const invite = cache[m.id] ? cache[m.id].invite : '';
    const link = extractInviteLink(invite);
    const [date, hm] = (m.time || '').split(' ');
    return tpl
      .replace(/\{topic\}/g, m.topic || '')
      .replace(/\{time\}/g, m.time || '')
      .replace(/\{date\}/g, date || '')
      .replace(/\{hm\}/g, hm || '')
      .replace(/\{duration\}/g, m.duration || '')
      .replace(/\{code\}/g, cp.code || '')
      .replace(/\{pwd\}/g, cp.pwd || '')
      .replace(/\{link\}/g, link)
      .replace(/\{invite\}/g, invite);
  }

  async function runExtract() {
    const targets = scanned.filter(m => m.checked);
    if (!targets.length) return;
    setRunningUI(true, 'extract');
    exPbar.classList.remove('delete');
    exPbar.style.width = '100%';
    exportProgressBox.classList.add('active');
    exPtext.textContent = `提取（snapshot）...`;

    const tpl = (globals.outputTemplate || '').trim();
    const all = targets.map(m => tpl ? applyTemplate(m, tpl) : formatSnapshot(m));
    const sep = '\n' + '='.repeat(25) + '\n';
    lastResult = all.join(sep);
    resultArea.value = lastResult;
    exportResultBox.classList.add('active');

    try { GM_setClipboard(lastResult, 'text'); log(`✓ ${all.length} 条已复制（${tpl ? '模板' : 'snapshot'} 格式）`); }
    catch (_) { try { await navigator.clipboard.writeText(lastResult); } catch (e) { log('自动复制失败，请手动复制下方文本'); } }
    exPtext.textContent = `完成 ${all.length} 条`;
    setRunningUI(false);
    exCopyBtn.style.display = lastResult ? '' : 'none';
  }

  // ========== 入会链接缓存 ==========
  function getInviteCache() { return lsLoad(LS.inviteCache, {}); }
  function setInviteCache(id, text) {
    const c = getInviteCache();
    c[id] = { invite: text, cachedAt: new Date().toISOString() };
    lsSave(LS.inviteCache, c);
  }

  // 注入剪贴板拦截
  function installPageHook() {
    const dataEl = document.createElement('div');
    dataEl.id = '__sjtu_copy_bridge';
    dataEl.style.display = 'none';
    document.body.appendChild(dataEl);
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        var bridge = document.getElementById('__sjtu_copy_bridge');
        if (!bridge) return;
        var origExec = document.execCommand.bind(document);
        document.execCommand = function(cmd) {
          if (cmd === 'copy') {
            try {
              var sel = window.getSelection();
              if (sel && sel.toString()) {
                bridge.textContent = sel.toString();
                bridge.setAttribute('data-ts', Date.now());
              }
            } catch(e) {}
          }
          return origExec.apply(document, arguments);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          var origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
          navigator.clipboard.writeText = function(text) {
            bridge.textContent = text;
            bridge.setAttribute('data-ts', Date.now());
            return origWrite(text);
          };
        }
      })();
    `;
    document.head.appendChild(script);
    script.remove();
  }
  function readCaptured() { const e = document.getElementById('__sjtu_copy_bridge'); return e ? e.textContent : ''; }
  function clearCaptured() { const e = document.getElementById('__sjtu_copy_bridge'); if (e) { e.textContent = ''; e.removeAttribute('data-ts'); } }
  async function waitForCaptured(timeoutMs = 3000) {
    const s = Date.now();
    while (Date.now() - s < timeoutMs) {
      const t = readCaptured();
      if (t) return t;
      await sleep(150);
    }
    return '';
  }

  async function extractOneMeeting(rowIndex) {
    const trs = document.querySelectorAll('.el-table__body tbody tr.el-table__row');
    if (rowIndex >= trs.length) return null;
    const row = trs[rowIndex];
    const viewBtn = row.querySelector('button[title="查看"]') || row.querySelector('button.is-circle');
    if (!viewBtn) return null;
    viewBtn.click();
    await sleep(1500);
    let dialog;
    try {
      dialog = await waitFor(() => {
        const d = document.querySelector('.meeting-view-dialog .el-dialog');
        return (d && d.offsetParent !== null) ? d : null;
      }, 8000);
    } catch (e) { return null; }
    await sleep(800);
    clearCaptured();
    const copyLink = findLinkByText(dialog, '复制信息');
    let info = '';
    if (copyLink) {
      copyLink.click();
      info = await waitForCaptured(3000);
      if (!info) { try { info = await navigator.clipboard.readText(); } catch (_) {} }
    }
    if (!info) {
      const pane = dialog.querySelector('#pane-1') || dialog.querySelector('.el-tab__content');
      if (pane) {
        const parts = [];
        pane.querySelectorAll('.page-content').forEach(div => {
          const t = div.textContent.trim();
          if (t && !t.startsWith('复制信息')) parts.push(t);
        });
        info = parts.join('\n');
      }
    }
    const closeBtn2 = findButtonByText('关闭', dialog) || dialog.querySelector('.el-dialog__headerbtn');
    if (closeBtn2) { closeBtn2.click(); await sleep(1000); }
    await sleep(500);
    return info;
  }

  async function runExtractFull() {
    const targets = scanned.filter(m => m.checked);
    if (!targets.length) return;
    const cache = getInviteCache();
    const cachedIds = targets.filter(m => cache[m.id]).map(m => m.id);
    const uncached = targets.filter(m => !cache[m.id]);
    log(`🔗 已缓存 ${cachedIds.length}；需抓 ${uncached.length}`);
    if (uncached.length >= 5) {
      if (!confirm(`要打开 ${uncached.length} 条详情抓邀请文本（每条 ~3s，预计 ${Math.ceil(uncached.length * 3.5)}s）。继续？`)) return;
    }
    cancelFlag = false;
    setRunningUI(true, 'extract');
    exPbar.classList.remove('delete');
    exPbar.style.width = '0%';
    exportProgressBox.classList.add('active');

    let scraped = 0;
    for (let i = 0; i < uncached.length; i++) {
      if (cancelFlag) break;
      const m = uncached[i];
      exPtext.textContent = `抓取 ${i + 1}/${uncached.length}: 「${m.topic}」`;
      exPbar.style.width = `${((i + 1) / uncached.length) * 80}%`;
      try {
        const info = await extractOneMeeting(m.idx);
        if (info) { setInviteCache(m.id, info.trim()); scraped++; }
      } catch (e) { log(`第 ${m.idx + 1} 行异常: ${e.message}`); }
      if (i < uncached.length - 1 && !cancelFlag) await sleep(800);
    }

    exPbar.style.width = '95%';
    const cacheNow = getInviteCache();
    const tpl = (globals.outputTemplate || '').trim();
    const all = targets.map(m => {
      const c = cacheNow[m.id];
      if (tpl) return applyTemplate(m, tpl);
      if (c && c.invite) return c.invite;
      return formatSnapshot(m) + '\n（⚠️ 链接抓取失败）';
    });
    const sep = '\n\n' + '='.repeat(25) + '\n\n';
    lastResult = all.join(sep);
    resultArea.value = lastResult;
    exportResultBox.classList.add('active');

    try { GM_setClipboard(lastResult, 'text'); }
    catch (_) { try { await navigator.clipboard.writeText(lastResult); } catch (e) {} }
    log(`✓ ${targets.length} 条已复制（${scraped} 新抓 + ${cachedIds.length} 缓存）`);
    exPbar.style.width = '100%';
    exPtext.textContent = `完成 ${targets.length} 条`;
    setRunningUI(false);
    exCopyBtn.style.display = lastResult ? '' : 'none';
  }

  // ========== 导出 ICS ==========
  function isoToIcs(s) {
    // 输入 "YYYY-MM-DD HH:MM"，输出 "YYYYMMDDTHHMMSS"
    return s.replace(/-/g, '').replace(' ', 'T').replace(/:/g, '') + '00';
  }
  function durationToMinutes(d) {
    if (!d) return 60;
    const m = d.match(/^([\d.]+)/);
    if (!m) return 60;
    const v = parseFloat(m[1]);
    if (d.includes('小时')) return Math.round(v * 60);
    if (d.includes('分钟')) return Math.round(v);
    return 60;
  }
  function generateIcs(targets) {
    const cache = getInviteCache();
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SJTU Meeting Toolkit//v3.0//ZH',
      'CALSCALE:GREGORIAN',
    ];
    for (const m of targets) {
      const startIcs = isoToIcs(m.time);
      const start = new Date(m.time.replace(' ', 'T'));
      const minutes = durationToMinutes(m.duration);
      const end = new Date(start.getTime() + minutes * 60000);
      const endIcs = `${end.getFullYear()}${String(end.getMonth() + 1).padStart(2, '0')}${String(end.getDate()).padStart(2, '0')}T${String(end.getHours()).padStart(2, '0')}${String(end.getMinutes()).padStart(2, '0')}00`;
      const cp = parseCodePwd(m.codePwd);
      const invite = cache[m.id] ? cache[m.id].invite : '';
      const link = extractInviteLink(invite);
      const desc = [
        invite || `会议号：${cp.code}\\n密码：${cp.pwd}`,
        link ? '入会链接：' + link : '',
      ].filter(Boolean).join('\\n').replace(/\n/g, '\\n');
      lines.push(
        'BEGIN:VEVENT',
        `UID:sjtu-${m.id}@meeting.sjtu.edu.cn`,
        `DTSTAMP:${isoToIcs(todayStr() + ' 00:00')}`,
        `DTSTART;TZID=Asia/Shanghai:${startIcs}`,
        `DTEND;TZID=Asia/Shanghai:${endIcs}`,
        `SUMMARY:${(m.topic || '会议').replace(/[,;\\]/g, c => '\\' + c)}`,
        `DESCRIPTION:${desc.replace(/[,;]/g, c => '\\' + c)}`,
        link ? `URL:${link}` : '',
        'END:VEVENT'
      );
    }
    lines.push('END:VCALENDAR');
    return lines.filter(Boolean).join('\r\n');
  }
  function downloadIcs() {
    const targets = scanned.filter(m => m.checked);
    if (!targets.length) return;
    const ics = generateIcs(targets);
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sjtu-meetings-${todayStr()}-${targets.length}条.ics`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    log(`📥 已生成 ICS 文件（${targets.length} 个会议），导入 Apple/Google 日历即可`);
  }
  exIcsBtn.onclick = downloadIcs;

  // ========== 删除（原生批量 + 回收站归档） ==========
  async function runDelete() {
    const targets = scanned.filter(m => m.checked);
    if (!targets.length) return;
    const sample = targets.slice(0, 8).map(m => `  ${m.time}  ${m.topic || '（无主题）'}`).join('\n');
    const more = targets.length > 8 ? `\n  ... 还有 ${targets.length - 8} 条` : '';
    if (!confirm(`⚠️ 确认删除 ${targets.length} 个会议？\n\n${sample}${more}\n\n会归档到回收站，可在工具箱顶部"🗑 回收站"查看历史。`)) return;

    // 1. 归档到回收站
    archiveToRecycleBin(targets);
    log(`📦 已归档 ${targets.length} 条到回收站`);

    setRunningUI(true, 'delete');
    exPbar.classList.add('delete');
    exPbar.style.width = '20%';
    exportProgressBox.classList.add('active');
    exPtext.textContent = `准备删除 ${targets.length} 条...`;

    const batchBtn = findButtonByText('批量删除');
    if (!batchBtn) { log('❌ 找不到页面"批量删除"按钮'); setRunningUI(false); return; }

    let chk = 0;
    const ids = new Set(targets.map(m => m.id));
    const trs = document.querySelectorAll('.el-table__body tbody tr.el-table__row');
    for (const tr of trs) {
      const cells = tr.querySelectorAll('td');
      const rid = cells[1] ? cells[1].textContent.trim() : '';
      const lbl = tr.querySelector('td:first-child label.el-checkbox');
      if (!lbl) continue;
      const isChecked = lbl.classList.contains('is-checked');
      const want = ids.has(rid);
      if (want !== isChecked) lbl.click();
      if (want) chk++;
      await sleep(50);
    }
    exPbar.style.width = '50%';
    exPtext.textContent = `已勾 ${chk}/${targets.length}，点击批量删除...`;
    if (!chk) { log('❌ 0 行被勾选'); setRunningUI(false); return; }
    await sleep(300);
    if (batchBtn.disabled) { log('❌ 批量删除按钮 disabled'); setRunningUI(false); return; }
    batchBtn.click();
    exPbar.style.width = '70%';

    let dlg;
    try {
      dlg = await waitFor(() => {
        const d = document.querySelector('.el-message-box');
        return (d && d.offsetParent !== null) ? d : null;
      }, 5000);
    } catch (e) { log('❌ 确认对话框未出现'); setRunningUI(false); return; }
    await sleep(300);
    let okBtn = null;
    dlg.querySelectorAll('button').forEach(b => { if (/确定|确认/.test(b.textContent.trim()) && !okBtn) okBtn = b; });
    if (!okBtn) okBtn = dlg.querySelector('.el-button--primary');
    if (!okBtn) { log('❌ 确认按钮未找到'); setRunningUI(false); return; }
    okBtn.click();
    log('✓ 已点击确认...');
    exPbar.style.width = '90%';

    const before = trs.length;
    let deleted = 0;
    const start = Date.now();
    while (Date.now() - start < 15000) {
      await sleep(500);
      const now = document.querySelectorAll('.el-table__body tbody tr.el-table__row').length;
      if (now < before) {
        deleted = before - now;
        if (deleted >= chk) break;
      }
    }
    log(`🗑 完成：从 ${before} → ${before - deleted} 行`);
    exPbar.style.width = '100%';
    exPtext.textContent = `完成！删除 ${deleted} 条`;
    setRunningUI(false);
    setTimeout(doScan, 1000);
  }

  function setRunningUI(running, mode) {
    exGoBtn.style.display = running ? 'none' : '';
    exGoLinkBtn.style.display = running ? 'none' : '';
    exDelBtn.style.display = running ? 'none' : '';
    exIcsBtn.style.display = running ? 'none' : '';
    exRescanBtn.style.display = running ? 'none' : '';
    exStopBtn.style.display = running ? '' : 'none';
    if (running) exCopyBtn.style.display = 'none';
  }
  exGoBtn.onclick = runExtract;
  exGoLinkBtn.onclick = runExtractFull;
  exDelBtn.onclick = runDelete;
  exStopBtn.onclick = () => { cancelFlag = true; log('正在取消...'); };
  exCopyBtn.onclick = () => {
    if (!lastResult) return;
    try { GM_setClipboard(lastResult, 'text'); alert('已复制！'); }
    catch (_) {
      navigator.clipboard.writeText(lastResult).then(
        () => alert('已复制！'),
        () => alert('复制失败，请手动选择文本框内容复制')
      );
    }
  };

  // ========== 创建会议（核心） ==========
  async function pickSelectOption(triggerInput, text) {
    triggerInput.closest('.el-select').querySelector('.el-input').click();
    await sleep(600);
    const items = document.querySelectorAll('.el-select-dropdown__item');
    for (const it of items) {
      if (it.textContent.trim() === text) { it.click(); await sleep(300); return true; }
    }
    for (const it of items) {
      if (it.textContent.trim().includes(text)) { it.click(); await sleep(300); return true; }
    }
    return false;
  }
  async function createOneMeeting(job) {
    const tag = `[${job.date} ${job.time}]「${job.topic}」`;
    log(`${tag} 增加会议...`);
    const aBtn = findButtonByText('增加会议');
    if (aBtn) { aBtn.click(); await sleep(1200); }
    else await sleep(500);
    const topicEl = document.querySelector('.el-col-16 .el-input .el-input__inner');
    if (!topicEl) throw new Error('找不到主题输入框');
    simulateInput(topicEl, job.topic);
    await sleep(300);
    if (job.password) {
      const pw = document.querySelector('input[placeholder="6位纯数字"]');
      if (pw) simulateInput(pw, job.password);
      await sleep(300);
    }
    if (job.cohost) {
      const co = document.querySelector('input[placeholder*="jAccount"]');
      if (co) simulateInput(co, job.cohost);
      await sleep(300);
    }
    const dateEl = document.querySelector('input[placeholder="选择日期"]');
    if (!dateEl) throw new Error('找不到日期输入框');
    dateEl.focus(); dateEl.click(); await sleep(400);
    setNativeValue(dateEl, job.date);
    dateEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    await sleep(400); document.body.click(); await sleep(400);
    const timeEl = document.querySelector('input[placeholder="时间"]');
    if (!timeEl) throw new Error('找不到时间输入框');
    timeEl.focus(); timeEl.click(); await sleep(400);
    setNativeValue(timeEl, job.time);
    await sleep(300); document.body.click(); await sleep(400);
    const durEl = document.querySelector('input[placeholder="请选择"]');
    if (durEl) {
      const ok = await pickSelectOption(durEl, job.duration);
      if (!ok) log(`${tag} ⚠ 时长未匹配`);
    }
    await sleep(400);
    const sb = findButtonByText('提交申请');
    if (!sb) throw new Error('找不到"提交申请"按钮');
    sb.click();
    await sleep(2500);
    const errEl = document.querySelector('.el-message--error');
    if (errEl) throw new Error('提交失败: ' + errEl.textContent.trim());
    log(`${tag} ✅`);
  }

  function flattenJobs() {
    const jobs = [];
    rows.forEach((row, ri) => {
      const dates = generateDates(row.startDate, row.endDate, row.weekdays);
      for (const d of dates) {
        jobs.push({ rowIndex: ri, topic: row.topic, password: row.password, cohost: row.cohost, time: row.time, duration: row.duration, date: d, sortKey: d + 'T' + row.time });
      }
    });
    jobs.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    return jobs;
  }
  function validateRows() {
    const errs = [];
    rows.forEach((row, ri) => {
      const t = `任务 #${ri + 1}`;
      if (!row.topic) errs.push(`${t}: 主题为空`);
      if (!row.startDate || !row.endDate) errs.push(`${t}: 日期未填`);
      if (!row.weekdays.length) errs.push(`${t}: 未选星期`);
      if (!row.time) errs.push(`${t}: 时间未填`);
      if (row.startDate && row.endDate && row.startDate > row.endDate) errs.push(`${t}: 开始>结束`);
    });
    return errs;
  }
  previewBtn.onclick = () => {
    const errs = validateRows();
    if (errs.length) return alert('配置不完整:\n' + errs.join('\n'));
    const jobs = flattenJobs();
    clearChildren(previewBox);
    previewBox.classList.add('active');
    if (!jobs.length) {
      previewBox.appendChild(el('span', { style: { color: '#F56C6C' } }, '无匹配日期'));
      return;
    }
    previewBox.appendChild(el('strong', null, `合计 ${jobs.length} 个会议`));
    const byRow = new Map();
    jobs.forEach(j => { if (!byRow.has(j.rowIndex)) byRow.set(j.rowIndex, []); byRow.get(j.rowIndex).push(j); });
    for (const [ri, list] of byRow) {
      const r = rows[ri];
      previewBox.appendChild(el('div', { style: { fontWeight: '700', color: '#409EFF', marginTop: '6px' } }, `任务 #${ri + 1}「${r.topic}」 共 ${list.length} 次`));
      list.forEach((j, i) => {
        const wd = WEEKDAY_NAMES[new Date(j.date + 'T00:00:00').getDay()];
        previewBox.appendChild(el('div', null, `${i + 1}. ${j.date} (${wd}) ${j.time} · ${j.duration}`));
      });
    }
  };
  saveCfgBtn.onclick = () => { saveCurrentRows(); alert('当前任务列表已保存'); };
  goCreateBtn.onclick = async () => {
    const errs = validateRows();
    if (errs.length) return alert('配置不完整:\n' + errs.join('\n'));
    const jobs = flattenJobs();
    if (!jobs.length) return alert('无匹配日期');
    const summary = rows.map((r, i) => {
      const cnt = jobs.filter(j => j.rowIndex === i).length;
      return `  #${i + 1} ${r.topic} → ${cnt} 次`;
    }).join('\n');
    if (!confirm(`即将创建 ${jobs.length} 个会议（${rows.length} 个任务行）：\n\n${summary}\n\n确定？`)) return;
    cancelFlag = false;
    const task = { jobs, delay: globals.delaySeconds, index: 0, success: 0, fail: 0, rowsSnapshot: JSON.parse(JSON.stringify(rows)) };
    await runBatch(task);
  };
  stopCreateBtn.onclick = () => { cancelFlag = true; log('正在取消...'); };

  async function runBatch(task) {
    const { jobs, delay } = task;
    let { index, success, fail } = task;
    if (!window.location.pathname.includes('/jwb/new')) {
      log('跳转到创建页面...');
      lsSave(LS.runtimeTask, task);
      window.location.href = 'https://meeting.sjtu.edu.cn/jwb/new';
      return;
    }
    setCreateRunningUI(true);
    createProgressBox.classList.add('active');
    for (let i = index; i < jobs.length; i++) {
      if (cancelFlag) { log('⛔ 取消'); break; }
      const j = jobs[i];
      const wd = WEEKDAY_NAMES[new Date(j.date + 'T00:00:00').getDay()];
      createPtext.textContent = `${i + 1}/${jobs.length}: 「${j.topic}」${j.date} (${wd}) ${j.time}`;
      createPbar.style.width = `${((i + 1) / jobs.length) * 100}%`;
      task.index = i; task.success = success; task.fail = fail;
      lsSave(LS.runtimeTask, task);
      try { await createOneMeeting(j); success++; }
      catch (e) { fail++; log(`❌ ${j.date} ${j.topic}: ${e.message}`); }
      if (i < jobs.length - 1 && !cancelFlag) { log(`等 ${delay}s...`); await sleep(delay * 1000); }
    }
    lsDel(LS.runtimeTask);
    createPtext.textContent = `完成: 成功 ${success}，失败 ${fail}`;
    log(`🎉 批量完成: ${success}/${jobs.length}`);
    setCreateRunningUI(false);
  }
  function setCreateRunningUI(running) {
    goCreateBtn.style.display = running ? 'none' : '';
    previewBtn.style.display = running ? 'none' : '';
    saveCfgBtn.style.display = running ? 'none' : '';
    addBtn.style.display = running ? 'none' : '';
    stopCreateBtn.style.display = running ? '' : 'none';
  }

  // ========== 初始化 ==========
  loadAll();
  syncGlobalsToUI();
  renderRows();
  renderList();
  renderPresets();
  installPageHook();
  log(`🎯 工具箱 v3.1 已加载 — 任务 ${rows.length} 行 / 预设 ${presets.length} / 学期 ${rangeStartDate()} → ${rangeEndDate()}`);

  // 跨页面恢复 batch
  const pending = lsLoad(LS.runtimeTask, null);
  if (pending && pending.jobs && pending.index < pending.jobs.length) {
    log(`检测到未完成任务（${pending.index}/${pending.jobs.length}），3 秒后恢复...`);
    mainOverlay.classList.add('active');
    setTab('create');
    if (pending.rowsSnapshot) {
      rows = pending.rowsSnapshot.map(r => ({ ...defaultRow(), ...r, id: uid() }));
      renderRows();
    }
    setTimeout(() => { if (!cancelFlag) runBatch(pending); }, 3000);
  }

})();
