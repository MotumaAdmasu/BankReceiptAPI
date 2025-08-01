const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const app = express();
const PORT = 2268;
const dbFile = './db.db';

// Create DB file if not exists
if (!fs.existsSync(dbFile)) {
  fs.writeFileSync(dbFile, '');
}

// Init SQLite database
const db = new sqlite3.Database(dbFile);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transactionId TEXT,
    link TEXT,
    response TEXT,
    ip TEXT,
    userAgent TEXT,
    timestamp TEXT
  )`);
});

// HTTPS Agent (for CBE cert bypass)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Helper to log with +3 hour timestamp
function logToDatabase(transactionId, link, responseData, ip, userAgent) {
  const timestamp = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(); // +3 hours
  const stmt = db.prepare("INSERT INTO logs (transactionId, link, response, ip, userAgent, timestamp) VALUES (?, ?, ?, ?, ?, ?)");
  stmt.run(transactionId, link, JSON.stringify(responseData), ip, userAgent, timestamp);
  stmt.finalize();
}

// Parse FT (CBE) PDF
async function parseFT(link, transactionId) {
  const pdfResponse = await axios.get(link, {
    responseType: 'arraybuffer',
    httpsAgent
  });
  const pdfData = await pdfParse(pdfResponse.data);
  const text = pdfData.text.replace(/\r?\n/g, ' ').replace(/\s\s+/g, ' ');

  const extract = (label, after) => {
    const pattern = new RegExp(`${label}\\s*(.*?)\\s*${after}`, 'i');
    const match = text.match(pattern);
    return match ? match[1].trim() : null;
  };

  const payer = extract("Payer", "Account");
  const payerAccount = extract("Account", "Receiver");
  const receiver = extract("Receiver", "Account");
  const receiverAccount = extract("Account 1\\*\\*\\*\\*\\d{4}", "Payment Date & Time") || "1000009338067";
  const dateTime = extract("Payment Date & Time", "Reference No");
  const reference = extract("Reference No\\. \\(VAT Invoice No\\)", "Reason");
  const reason = extract("Reason / Type of service", "Transferred Amount");
  const totalAmount = extract("Total amount debited from customers account", "Amount in Word");

  return {
    source: 'CBE',
    transactionId,
    link,
    data: {
      payer,
      payerAccount: payerAccount || "Unknown",
      receiver,
      receiverAccount,
      paymentDateTime: dateTime,
      referenceNo: reference,
      reason,
      totalAmount: totalAmount ? `${totalAmount} ETB` : "Unknown"
    }
  };
}

// Parse Telebirr HTML
async function parseTelebirr(link, transactionId) {
  const htmlResponse = await axios.get(link);
  const html = htmlResponse.data;

  if (html.includes("This request is not correct")) {
    throw new Error("Invalid Telebirr transaction ID");
  }

  const $ = cheerio.load(html);

  const payerName = $('td:contains("የከፋይ ስም/Payer Name")').next().text().trim();
  const payerTelebirrNumber = $('td:contains("የከፋይ ቴሌብር ቁ./Payer telebirr no.")').next().text().trim();
  const creditedPartyName = $('td:contains("የገንዘብ ተቀባይ ስም/Credited Party name")').next().text().trim();
  const paymentType = $('td:contains("የክፍያ ምክንያት/Payment Reason")').next().text().trim();
  const accountNumber = $('td:contains("የባንክ አካውንት ቁጥር/Bank account number")').next().text().trim();

  const receiptHeader = $('td.receipttableTd2').first();
  const paymentDateHeader = receiptHeader.next();
  const receiptNumber = receiptHeader.parent().next().find('td').first().text().trim();
  const paymentDate = paymentDateHeader.parent().next().find('td').eq(1).text().trim();
  const totalAmountPaid = $('td:contains("ጠቅላላ የተከፈለ/Total Paid Amount")').next().text().trim();

  return {
    source: 'Telebirr',
    transactionId,
    link,
    data: {
      paymentType,
      payerName,
      payerTelebirrNumber,
      creditedPartyName,
      bankAccountNumber: accountNumber || 'Not available',
      receiptNumber,
      paymentDate,
      totalAmountPaid
    }
  };
}

// API Route
app.get('/getresult/:transactionId', async (req, res) => {
  const transactionId = req.params.transactionId;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
  const userAgent = req.headers['user-agent'] || 'Unknown';

  try {
    let result;
    let link;

    if (transactionId.startsWith('FT')) {
      link = `https://apps.cbe.com.et:100/?id=${transactionId}W09338067`;
      result = await parseFT(link, transactionId);
    } else {
      link = `https://transactioninfo.ethiotelecom.et/receipt/${transactionId}`;
      result = await parseTelebirr(link, transactionId);
    }

    logToDatabase(transactionId, link, result, ip, userAgent);
    res.json(result);

  } catch (error) {
    console.error(error.message);
    res.status(500).json({
      error: 'Failed to process transaction',
      detail: error.message,
      transactionId
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
