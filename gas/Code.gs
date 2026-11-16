/**
 * 日常餃子所｜線上訂單接收（Google Apps Script Web App）
 *
 * 部署步驟請見 gas/README.md。
 * 此腳本必須綁定在試算表（從試算表「擴充功能 > Apps Script」建立），
 * 才能用 SpreadsheetApp.getActiveSpreadsheet() 取得同一份試算表。
 */

const SHEET_NAME = '訂單';
const NOTIFY_EMAIL = ''; // 填入店家信箱即可收到新訂單通知；留空則不寄信
const FULFILLMENT_OPTIONS = ['內用', '外帶', '宅配'];
const MAX_ITEMS = 30;
const MAX_QTY = 50;
const HEADERS = ['訂單編號', '建立時間', '聯絡人', '電話', '取餐方式', '地址', '品項明細', '數量合計', '金額', '狀態'];

/** 健康檢查：用瀏覽器開啟部署網址即可確認服務運作中 */
function doGet() {
  return json_({ ok: true, service: 'orders', time: new Date().toISOString() });
}

/** 接收前端送來的訂單（Content-Type: text/plain，內容為 JSON 字串） */
function doPost(e) {
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const order = validateOrder_(data);

    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    let orderId;
    try {
      const sheet = getSheet_();
      orderId = nextOrderId_(sheet);
      sheet.appendRow([
        orderId,
        Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'),
        order.name,
        order.phone,
        order.fulfillment,
        order.address,
        order.items.map(i => `${i.name} x${i.quantity}（${i.price}）`).join('\n'),
        order.quantity,
        order.total,
        '待確認',
      ]);
    } finally {
      lock.releaseLock();
    }

    if (NOTIFY_EMAIL) notify_(orderId, order);
    return json_({ ok: true, orderId: orderId });
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) });
  }
}

/* ---------- 驗證 ---------- */

function validateOrder_(data) {
  // 蜜罐欄位：一般使用者看不到，機器人會填寫，填了就拒絕
  if (data.website) throw new Error('送出失敗，請重新整理後再試。');

  const name = String(data.name || '').trim();
  if (name.length < 1 || name.length > 30) throw new Error('請填寫聯絡人（1–30 字）。');

  const phone = String(data.phone || '').replace(/\D/g, '');
  if (!/^09\d{8}$/.test(phone)) throw new Error('電話格式不正確（請輸入 09 開頭的 10 碼手機號碼）。');

  const fulfillment = String(data.fulfillment || '');
  if (FULFILLMENT_OPTIONS.indexOf(fulfillment) === -1) throw new Error('取餐方式不正確。');

  const address = String(data.address || '').trim();
  if (fulfillment === '宅配' && (address.length < 5 || address.length > 120)) {
    throw new Error('宅配請填寫完整地址（5–120 字）。');
  }

  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > MAX_ITEMS) {
    throw new Error('購物車內容不正確。');
  }
  const items = data.items.map(item => {
    const qty = Number(item.quantity);
    const price = Number(item.price);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new Error('商品數量不正確。');
    if (!Number.isFinite(price) || price < 0 || price > 10000) throw new Error('商品單價不正確。');
    return {
      id: String(item.id || '').slice(0, 60),
      name: String(item.name || '').slice(0, 60),
      price: price,
      quantity: qty,
    };
  });

  const quantity = items.reduce((sum, i) => sum + i.quantity, 0);
  // TODO: 金額目前以前端傳來的單價計算。若要防止竄改，請在此加入商品價目表並比對 item.id。
  const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

  return { name, phone, fulfillment, address, items, quantity, total };
}

/* ---------- 試算表 ---------- */

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** 以目前列數產生序號，例如 DG-0001。需在 LockService 內呼叫。 */
function nextOrderId_(sheet) {
  const seq = sheet.getLastRow(); // 第 1 列為標題，因此第一筆訂單為 1
  return 'DG-' + String(seq).padStart(4, '0');
}

/* ---------- 通知與回應 ---------- */

function notify_(orderId, order) {
  const body = [
    `訂單編號：${orderId}`,
    `聯絡人：${order.name}（${order.phone}）`,
    `取餐方式：${order.fulfillment}${order.address ? '｜' + order.address : ''}`,
    '',
    ...order.items.map(i => `${i.name} x${i.quantity}　NT$ ${i.price * i.quantity}`),
    '',
    `合計：NT$ ${order.total}`,
  ].join('\n');
  MailApp.sendEmail(NOTIFY_EMAIL, `【日常餃子所】新訂單 ${orderId}`, body);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
