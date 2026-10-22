const puppeteer = require('puppeteer');
const pool = require('../config/db');

exports.generate = async (req, res) => {
  const { sectionId } = req.params;
  const [rows] = await pool.query(`
    SELECT s.lrn, u.full_name,
      SUM(a.status='present') AS days_present,
      SUM(a.status='absent')  AS days_absent
    FROM users u
    JOIN students s ON s.user_id=u.id
    LEFT JOIN attendance a ON a.student_id=u.id
    WHERE s.section_id=?
    GROUP BY u.id,s.lrn,u.full_name
    ORDER BY u.full_name`, [sectionId]);

  const html = `
    <html><head><style>
      body{font-family:Arial;padding:24px}
      h2{text-align:center}
      table{width:100%;border-collapse:collapse;margin-top:16px}
      th,td{border:1px solid #000;padding:6px;font-size:12px;text-align:left}
      th{background:#eee}
    </style></head><body>
      <h2>School Form 2 (SF2) — Daily Attendance Report</h2>
      <table>
        <tr><th>LRN</th><th>Name</th><th>Days Present</th><th>Days Absent</th><th>Remarks</th></tr>
        ${rows.map(r=>`<tr>
          <td>${r.lrn}</td><td>${r.full_name}</td>
          <td>${r.days_present}</td><td>${r.days_absent}</td>
          <td>${r.days_absent>4?'Needs Intervention':'Good Standing'}</td>
        </tr>`).join('')}
      </table>
    </body></html>`;

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  await browser.close();

  res.contentType('application/pdf');
  res.send(pdf);
};