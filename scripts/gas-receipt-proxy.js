/**
 * Google Apps Script — レシート画像受信プロキシ
 *
 * iOSショートカットからPOSTされた画像を Google Drive の受信箱フォルダに保存する。
 * Mac mini の receipt-watcher.js がこのフォルダを監視して OCR 処理を行う。
 *
 * ── このコードをGASエディタに貼り付けてください ──
 */

const INBOX_FOLDER_ID = "1LYxVdh6rpNOEoL-tjOrgYihCJ6VMtdbk";
const AUTH_TOKEN = "shiratama-receipt-2026";

const BUSINESS_MAP = {
  "1": "えんがわ",
  "2": "となりにとまる",
  "3": "三十日珈琲",
  "4": "SATOYAMA AI BASE",
  "5": "共通",
  "6": "プライベート",
};

function doPost(e) {
  try {
    var token = e.parameter.token || "";
    if (token !== AUTH_TOKEN) {
      return ContentService.createTextOutput(JSON.stringify({ error: "Unauthorized" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var bKey = (e.parameter.b || "").trim();
    var business = BUSINESS_MAP[bKey] || "不明";
    var timestamp = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd_HHmmss");
    var fileName = business + "_" + timestamp + ".jpg";

    var imageData = e.postData.contents || "";
    imageData = imageData.replace(/^data:[^;]+;base64,/, "").trim();
    imageData = imageData.replace(/[\r\n\s]/g, "");

    var decoded = Utilities.base64Decode(imageData);
    var blob = Utilities.newBlob(decoded, "image/jpeg", fileName);
    var folder = DriveApp.getFolderById(INBOX_FOLDER_ID);
    var file = folder.createFile(blob);

    Logger.log("Saved: " + fileName + " (" + file.getSize() + " bytes)");

    return ContentService.createTextOutput(JSON.stringify({
      success: true, fileName: fileName, business: business, size: file.getSize()
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log("ERROR: " + err.message);
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}
