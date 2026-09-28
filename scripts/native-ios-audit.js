#!/usr/bin/env node
/**
 * native-ios-audit.js — حراسة مشروع iOS الأصلي (ios-native/).
 *
 * يتحقق من:
 *  1) عدم وجود أسرار (.p8 / AuthKey / PRIVATE KEY) داخل ios-native.
 *  2) عدم وجود WebView/WKWebView/SafariServices/UIWebView في مصادر Swift
 *     (التطبيق Native بالكامل — لا WebView كواجهة).
 *  3) اكتمال project.pbxproj: كل ملف .swift على القرص مُشار إليه،
 *     وكل مرجع .swift في pbxproj موجود على القرص.
 *  4) عدم الإشارة إلى Capacitor/Cordova في المشروع الأصلي.
 *
 * الاستخدام: node scripts/native-ios-audit.js
 * الخروج برمز 0 = نظيف · 1 = مخالفات.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "ios-native");
const failures = [];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "DerivedData" || entry.name === ".build") continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

if (!fs.existsSync(ROOT)) {
  console.error("❌ ios-native/ غير موجود");
  process.exit(1);
}

const files = walk(ROOT);
const rel = (f) => path.relative(path.join(__dirname, ".."), f).replace(/\\/g, "/");

// 1) أسرار
const secretPatterns = [/\.p8$/i, /AuthKey_/i, /PRIVATE KEY/i];
for (const f of files) {
  for (const p of secretPatterns) {
    if (p.test(path.basename(f)) || (p.source === "PRIVATE KEY" && false)) {
      failures.push(`سرّ محتمل داخل ios-native: ${rel(f)}`);
    }
  }
  if (/\.(plist|json|swift|entitlements|md)$/i.test(f)) {
    const content = fs.readFileSync(f, "utf8");
    if (content.includes("-----BEGIN PRIVATE KEY-----")) {
      failures.push(`مفتاح خاص مضمّن في: ${rel(f)}`);
    }
  }
}

// 2) لا WebView
const swiftFiles = files.filter((f) => f.endsWith(".swift"));
const webPatterns = [/\bWKWebView\b/, /\bUIWebView\b/, /\bSFSafariViewController\b/, /\bWebView\b/, /import\s+WebKit/, /import\s+SafariServices/];
for (const f of swiftFiles) {
  const content = fs.readFileSync(f, "utf8");
  for (const p of webPatterns) {
    if (p.test(content)) {
      failures.push(`مرجع WebView في ${rel(f)}: ${p.source}`);
    }
  }
}

// 3) اكتمال pbxproj
const pbxPath = path.join(ROOT, "EMSOperations.xcodeproj", "project.pbxproj");
if (!fs.existsSync(pbxPath)) {
  failures.push("project.pbxproj غير موجود");
} else {
  const pbx = fs.readFileSync(pbxPath, "utf8");
  for (const f of swiftFiles) {
    const name = path.basename(f);
    if (!pbx.includes(name)) {
      failures.push(`ملف Swift غير مُسجّل في pbxproj: ${rel(f)}`);
    }
  }
  const referenced = [
    ...pbx.matchAll(/path = ([A-Za-z0-9_]+\.swift);/g),
    ...pbx.matchAll(/\/\* ([A-Za-z0-9_]+\.swift) in Sources \*\//g),
  ].map((m) => m[1]);
  for (const name of new Set(referenced)) {
    if (!swiftFiles.some((f) => path.basename(f) === name)) {
      failures.push(`مرجع Swift في pbxproj بلا ملف على القرص: ${name}`);
    }
  }
  // الموارد الأساسية
  for (const required of ["Assets.xcassets", "Info.plist", "EMSOperations.entitlements", "online.emsoperations.app"]) {
    if (!pbx.includes(required)) {
      failures.push(`pbxproj يفتقد: ${required}`);
    }
  }
}

// 4) لا Capacitor/Cordova في المشروع الأصلي
for (const f of files) {
  if (/\.(swift|plist|pbxproj|entitlements)$/i.test(f)) {
    const content = fs.readFileSync(f, "utf8");
    if (/\bCapacitor\b|\bCordova\b/i.test(content)) {
      failures.push(`مرجع Capacitor/Cordova في: ${rel(f)}`);
    }
  }
}

// النتيجة
if (failures.length) {
  console.error(`❌ native-ios-audit: ${failures.length} مخالفة:`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ native-ios-audit: نظيف (${swiftFiles.length} ملف Swift، ${files.length} ملف إجمالًا)`);
