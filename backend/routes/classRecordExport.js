// routes/classRecordExport.js
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, authorize('teacher'));

// Same transmutation table as frontend
const TRANSMUTATION = [
  [99.49,100],[98.31,99],[97.13,98],[95.95,97],[94.77,96],[93.59,95],[92.41,94],[91.23,93],
  [90.05,92],[88.87,91],[87.69,90],[86.51,89],[85.33,88],[84.15,87],[82.97,86],[81.79,85],
  [80.61,84],[79.43,83],[78.25,82],[77.07,81],[75.89,80],[74.71,79],[73.53,78],[72.35,77],
  [71.17,76],[69.99,75],[65.33,74],[60.66,73],[56,72],[51.33,71],[46.66,70],[42,69],
  [37.33,68],[32.67,67],[28,66],[23.34,65],[18.67,64],[14,63],[9.34,62],[4.67,61],[0,60]
];

const SUBJECT_WEIGHTS = {
  'Academic Electives':                          [0.20, 0.50, 0.30],
  'Arts Apprenticeship':                         [0.15, 0.70, 0.15],
  'Arts, Sports, Health and Wellness Electives': [0.20, 0.60, 0.20],
  'Core Subjects':                               [0.20, 0.50, 0.30],
  'Creative Production and Innovation':          [0.15, 0.70, 0.15],
  'Design and Innovation':                       [0.40, 0.60, 0.00],
  'Field Exposure':                              [0.15, 0.70, 0.15],
  'Research Electives':                          [0.40, 0.60, 0.00],
  'TechPro Electives':                           [0.15, 0.65, 0.20],
  'Work Immersion':                              [0.20, 0.80, 0.00]
};

// Normalize a gender string to 'male' | 'female' (defaults to 'male')
function normalizeGender(g) {
  const v = String(g || '').trim().toLowerCase();
  if (v === 'female' || v === 'f') return 'female';
  return 'male';
}

// Fetch helper: students + grades for one term, INCLUDING gender
async function fetchTermRows(pool, teacherId, subjectId, term) {
  const [rows] = await pool.query(`
    SELECT u.id AS student_id, u.full_name, s.lrn, s.gender,
           g.ww1, g.ww2, g.ww3, g.ww4, g.ww5,
           g.pt1, g.pt2, g.pt3, g.ex1, g.ex2, g.ex3,
           g.ww1_hps, g.ww2_hps, g.ww3_hps, g.ww4_hps, g.ww5_hps,
           g.pt1_hps, g.pt2_hps, g.pt3_hps,
           g.ex1_hps, g.ex2_hps, g.ex3_hps
    FROM subjects sub
    JOIN sections sec ON sec.id = sub.section_id
    JOIN students s   ON s.section_id = sec.id
    JOIN users u      ON u.id = s.user_id
    LEFT JOIN grades g ON g.student_id = u.id AND g.subject_id = sub.id AND g.term = ?
    WHERE sub.teacher_id = ? AND sub.id = ?
    ORDER BY u.full_name
  `, [term, teacherId, subjectId]);
  return rows;
}

async function fetchMeta(pool, teacherId, subjectId) {
  const [[meta]] = await pool.query(`
    SELECT sub.name AS subject_name, sec.name AS section,
           u.full_name AS teacher_name
    FROM subjects sub
    JOIN sections sec ON sec.id = sub.section_id
    JOIN users u      ON u.id = sub.teacher_id
    WHERE sub.teacher_id = ? AND sub.id = ?
  `, [teacherId, subjectId]);
  return meta;
}

// -----------------------------------------------------------------------------
// Build one term sheet, WITH gender split
// -----------------------------------------------------------------------------
function buildTermSheet(wb, term, rows, meta, weights, subjectType) {
  const sheetName = `TERM ${term}`;
  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 15 }]
  });

  // Column widths
  const widths = {
    A: 6, B: 30, C: 6, D: 6, E: 6, F: 6, G: 6, H: 8, I: 8, J: 8,
    K: 6, L: 6, M: 6, N: 8, O: 8, P: 8, Q: 6, R: 6, S: 6, T: 8, U: 8, V: 8,
    W: 10, X: 10, Y: 12
  };
  Object.entries(widths).forEach(([k, v]) => { ws.getColumn(k).width = v; });

  // Header rows
  ws.mergeCells('A1:Y1');
  ws.getCell('A1').value = `CLASS RECORD - TERM ${term}`;
  ws.getCell('A1').font = { bold: true, size: 14 };

  ws.mergeCells('A3:Y3');
  ws.getCell('A3').value = '(Pursuant to DepEd Order 15 series of 2026)';
  ws.getCell('A3').font = { italic: true, size: 10, color: { argb: 'FF666666' } };

  ws.getCell('C5').value = 'REGION:';
  ws.getCell('G5').value = 'I';
  ws.getCell('N5').value = 'DIVISION';
  ws.getCell('P5').value = 'PANGASINAN II';
  ws.getCell('U5').value = 'SCHOOL ID';
  ws.getCell('W5').value = '300341';

  ws.getCell('C7').value = 'SCHOOL NAME:';
  ws.getCell('G7').value = 'ROSALES NATIONAL HIGH SCHOOL';
  ws.getCell('S7').value = 'SCHOOL YEAR:';
  ws.getCell('W7').value = '2026-2027';

  ws.getCell('A10').value = `TERM ${term}`;
  ws.getCell('C10').value = 'GRADE LEVEL';
  ws.getCell('H10').value = '11';
  ws.getCell('N10').value = 'TEACHER:';
  ws.getCell('P10').value = meta.teacher_name;
  ws.getCell('U10').value = 'SUBJECT:';
  ws.getCell('W10').value = meta.subject_name;

  ws.getCell('C11').value = 'SECTION';
  ws.getCell('H11').value = meta.section;
  ws.getCell('N11').value = 'TRACK:';
  ws.getCell('P11').value = 'ACADEMIC';
  ws.getCell('U11').value = 'SUBJECT TYPE:';
  ws.getCell('W11').value = subjectType;

  // Weight lookup via Sheet2
  ws.getCell('C13').value = { formula: `VLOOKUP(W11,Sheet2!$A$2:$D$11,2,TRUE)` };
  ws.getCell('K13').value = { formula: `VLOOKUP(W11,Sheet2!$A$2:$D$11,3,TRUE)` };
  ws.getCell('Q13').value = { formula: `VLOOKUP(W11,Sheet2!$A$2:$D$11,4,TRUE)` };

  // Category headers
  ws.mergeCells('C12:H12');
  ws.getCell('C12').value = 'WRITTEN/ORAL WORKS (WWs)';
  ws.getCell('C12').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
  ws.getCell('C12').font = { bold: true };

  ws.mergeCells('K12:N12');
  ws.getCell('K12').value = 'PRODUCT/PERFORMANCE TASKS (PTs)';
  ws.getCell('K12').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
  ws.getCell('K12').font = { bold: true };

  ws.mergeCells('Q12:T12');
  ws.getCell('Q12').value = 'EXAMINATIONS (EXs)';
  ws.getCell('Q12').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
  ws.getCell('Q12').font = { bold: true };

  // Sub-headers row 14
  ['1', '2', '3', '4', '5', 'TOTAL', 'PS', 'WS'].forEach((h, i) => {
    const cell = ws.getRow(14).getCell(3 + i);
    cell.value = h;
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center' };
  });
  ['1', '2', '3', 'TOTAL', 'PS', 'WS'].forEach((h, i) => {
    const cell = ws.getRow(14).getCell(11 + i);
    cell.value = h;
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center' };
  });
  ['SA1', 'SA2', 'TE', 'TOTAL', 'PS', 'WS'].forEach((h, i) => {
    const cell = ws.getRow(14).getCell(17 + i);
    cell.value = h;
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center' };
  });

  // HPS row
  ws.getCell('B15').value = 'HIGHEST POSSIBLE SCORE';
  ws.getCell('B15').font = { bold: true };
  const hpsRef = rows[0] || {};
  ['ww1_hps', 'ww2_hps', 'ww3_hps', 'ww4_hps', 'ww5_hps'].forEach((f, i) => {
    ws.getRow(15).getCell(3 + i).value = hpsRef[f] ?? 100;
  });
  ws.getCell('H15').value = { formula: 'SUM(C15:G15)' };
  ws.getCell('I15').value = 100;
  ws.getCell('J15').value = { formula: 'I15*$C$13' };

  ['pt1_hps', 'pt2_hps', 'pt3_hps'].forEach((f, i) => {
    ws.getRow(15).getCell(11 + i).value = hpsRef[f] ?? 100;
  });
  ws.getCell('N15').value = { formula: 'SUM(K15:M15)' };
  ws.getCell('O15').value = 100;
  ws.getCell('P15').value = { formula: 'O15*$K$13' };

  ['ex1_hps', 'ex2_hps', 'ex3_hps'].forEach((f, i) => {
    ws.getRow(15).getCell(17 + i).value = hpsRef[f] ?? 100;
  });
  ws.getCell('T15').value = { formula: 'SUM(Q15:S15)' };
  ws.getCell('U15').value = 100;
  ws.getCell('V15').value = { formula: 'U15*$Q$13' };

  // Row 16 — column headers
  ws.getCell('B16').value = "LEARNERS' NAMES";
  ws.getCell('B16').font = { bold: true };
  ws.getCell('W16').value = 'Initial Grade';
  ws.getCell('X16').value = 'Term Grade';
  ws.getCell('Y16').value = 'Descriptor';
  ws.getRow(16).font = { bold: true };

  // ---- Split rows into MALE / FEMALE ----
  const male = [];
  const female = [];
  rows.forEach(r => {
    (normalizeGender(r.gender) === 'female' ? female : male).push(r);
  });

  let cursor = 17;

  // Writes one gender block and returns the next available row
  const writeBlock = (label, list) => {
    // Section label row (e.g. "MALE")
    ws.getCell(`A${cursor}`).value = label;
    ws.getCell(`A${cursor}`).font = { bold: true, italic: true };
    ws.mergeCells(`A${cursor}:B${cursor}`);
    cursor++;

    list.forEach((s, i) => {
      const row = ws.getRow(cursor);
      row.getCell(1).value = i + 1;             // restart numbering per gender
      row.getCell(2).value = s.full_name;
      row.getCell(3).value = s.ww1 ?? '';
      row.getCell(4).value = s.ww2 ?? '';
      row.getCell(5).value = s.ww3 ?? '';
      row.getCell(6).value = s.ww4 ?? '';
      row.getCell(7).value = s.ww5 ?? '';
      row.getCell(8).value = { formula: `SUM(C${cursor}:G${cursor})` };
      row.getCell(9).value = { formula: `IF(OR(H${cursor}=0),"",H${cursor}/$H$15*100)` };
      row.getCell(10).value = { formula: `IFERROR(I${cursor}*$C$13,"")` };

      row.getCell(11).value = s.pt1 ?? '';
      row.getCell(12).value = s.pt2 ?? '';
      row.getCell(13).value = s.pt3 ?? '';
      row.getCell(14).value = { formula: `SUM(K${cursor}:M${cursor})` };
      row.getCell(15).value = { formula: `IF(OR(N${cursor}=0),"",N${cursor}/$N$15*100)` };
      row.getCell(16).value = { formula: `IFERROR(O${cursor}*$K$13,"")` };

      row.getCell(17).value = s.ex1 ?? '';
      row.getCell(18).value = s.ex2 ?? '';
      row.getCell(19).value = s.ex3 ?? '';
      row.getCell(20).value = { formula: `SUM(Q${cursor}:S${cursor})` };
      row.getCell(21).value = { formula: `IF(OR(T${cursor}=0),"",T${cursor}/$T$15*100)` };
      row.getCell(22).value = { formula: `IFERROR(U${cursor}*$Q$13,"")` };

      row.getCell(23).value = {
        formula: `IF(OR(J${cursor}=0,P${cursor}=0),"",SUM(J${cursor},P${cursor},V${cursor}))`
      };
      row.getCell(24).value = {
        formula: `IF(W${cursor}="","",IF(W${cursor}>99.49,100,IF(W${cursor}>98.31,99,IF(W${cursor}>97.13,98,IF(W${cursor}>95.95,97,IF(W${cursor}>94.77,96,IF(W${cursor}>93.59,95,IF(W${cursor}>92.41,94,IF(W${cursor}>91.23,93,IF(W${cursor}>90.05,92,IF(W${cursor}>88.87,91,IF(W${cursor}>87.69,90,IF(W${cursor}>86.51,89,IF(W${cursor}>85.33,88,IF(W${cursor}>84.15,87,IF(W${cursor}>82.97,86,IF(W${cursor}>81.79,85,IF(W${cursor}>80.61,84,IF(W${cursor}>79.43,83,IF(W${cursor}>78.25,82,IF(W${cursor}>77.07,81,IF(W${cursor}>75.89,80,IF(W${cursor}>74.71,79,IF(W${cursor}>73.53,78,IF(W${cursor}>72.35,77,IF(W${cursor}>71.17,76,IF(W${cursor}>69.99,75,IF(W${cursor}>65.33,74,IF(W${cursor}>60.66,73,IF(W${cursor}>56,72,IF(W${cursor}>51.33,71,IF(W${cursor}>46.66,70,IF(W${cursor}>42,69,IF(W${cursor}>37.33,68,IF(W${cursor}>32.67,67,IF(W${cursor}>28,66,IF(W${cursor}>23.34,65,IF(W${cursor}>18.67,64,IF(W${cursor}>14,63,IF(W${cursor}>9.34,62,IF(W${cursor}>4.67,61,IF(W${cursor}>0,60,0)))))))))))))))))))))))))))))))))))))))))`
      };
      row.getCell(25).value = {
        formula: `IF(X${cursor}="","",IF(X${cursor}>89,"Advancing",IF(X${cursor}>79,"Benchmarking",IF(X${cursor}>74,"Connecting",IF(X${cursor}>64,"Developing",IF(X${cursor}>0,"Emerging",0))))))`
      };

      cursor++;
    });
  };

  writeBlock('MALE', male);
  writeBlock('FEMALE', female);

  // Signature block
  const sig = cursor + 1;
  ws.getCell(`A${sig}`).value = 'Prepared by:';
  ws.getCell(`F${sig}`).value = 'Checked by:';
  ws.getCell(`T${sig}`).value = 'Approved:';
  ws.getCell(`B${sig + 1}`).value = meta.teacher_name;
  ws.getCell(`I${sig + 1}`).value = 'CONRADO C. AREOLA JR.';
  ws.getCell(`V${sig + 1}`).value = 'ROWENA LEA G. MORENO';
  ws.getCell(`B${sig + 2}`).value = 'Subject Teacher';
  ws.getCell(`I${sig + 2}`).value = 'SHS OIC Assistant Principal';
  ws.getCell(`V${sig + 2}`).value = 'Principal IV';

  return { sheet: ws };
}

function buildLookupSheet(wb) {
  const ws = wb.addWorksheet('Sheet2');
  ws.getColumn('A').width = 55;
  ws.getColumn('B').width = 8;
  ws.getColumn('C').width = 8;
  ws.getColumn('D').width = 8;

  ws.getRow(1).values = ['SUBJECT TYPE', 'WWs', 'PTs', 'STs-TE'];
  ws.getRow(1).font = { bold: true };

  Object.entries(SUBJECT_WEIGHTS).forEach(([name, w], i) => {
    ws.getRow(i + 2).values = [name, w[0], w[1], w[2]];
  });
}

// -----------------------------------------------------------------------------
// Build FINAL GRADE sheet, WITH gender split
// -----------------------------------------------------------------------------
function buildFinalSheet(wb, termRows, meta) {
  // Merge three terms by student
  const studentMap = new Map();
  for (const term of [1, 2, 3]) {
    for (const r of termRows[term]) {
      if (!studentMap.has(r.student_id)) {
        studentMap.set(r.student_id, {
          full_name: r.full_name,
          gender: normalizeGender(r.gender),
          terms: {}
        });
      }
      studentMap.get(r.student_id).terms[term] = r;
    }
  }

  const ws = wb.addWorksheet('FINAL GRADE');
  ws.getColumn('A').width = 6;
  ws.getColumn('B').width = 30;
  ws.getColumn('E').width = 10;
  ws.getColumn('F').width = 10;
  ws.getColumn('G').width = 10;
  ws.getColumn('H').width = 12;
  ws.getColumn('I').width = 16;
  ws.getColumn('J').width = 14;

  ws.mergeCells('A2:J2');
  ws.getCell('A2').value = 'CLASS RECORD - FINAL GRADES';
  ws.getCell('A2').font = { bold: true, size: 14 };

  ws.getCell('B5').value = 'REGION';
  ws.getCell('C5').value = 'I';
  ws.getCell('E5').value = 'DIVISION';
  ws.getCell('F5').value = 'PANGASINAN II';
  ws.getCell('H5').value = 'SCHOOL ID';
  ws.getCell('I5').value = '300341';

  ws.getCell('B6').value = 'SCHOOL NAME';
  ws.getCell('C6').value = 'ROSALES NATIONAL HIGH SCHOOL';
  ws.getCell('H6').value = 'SCHOOL YEAR';
  ws.getCell('I6').value = '2026-2027';

  ws.getCell('A9').value = 'GRADE LEVEL';
  ws.getCell('C9').value = '11';
  ws.getCell('F9').value = 'SUBJECT';
  ws.getCell('G9').value = meta.subject_name;

  ws.getCell('A10').value = 'SECTION';
  ws.getCell('C10').value = meta.section;
  ws.getCell('F10').value = 'TEACHER';
  ws.getCell('G10').value = meta.teacher_name;

  ws.getRow(12).values = ['', '', '', '', 'TERM GRADES', '', '', 'FINAL GRADE', 'DESCRIPTOR', 'REMARK'];
  ws.getRow(12).font = { bold: true };
  ws.getRow(13).values = ['', '', '', '', 'TERM 1', 'TERM 2', 'TERM 3', '', '', ''];
  ws.getRow(13).font = { bold: true };

  // Split students by gender
  const male = [];
  const female = [];
  for (const [, s] of studentMap) {
    (s.gender === 'female' ? female : male).push(s);
  }

  let cursor = 14;

  const writeBlock = (label, list) => {
    ws.getCell(`A${cursor}`).value = label;
    ws.getCell(`A${cursor}`).font = { bold: true, italic: true };
    ws.mergeCells(`A${cursor}:D${cursor}`);
    cursor++;

    list.forEach((s, i) => {
      const row = ws.getRow(cursor);
      row.getCell(1).value = i + 1;
      row.getCell(2).value = s.full_name;
      [1, 2, 3].forEach((t, idx) => {
        row.getCell(5 + idx).value = s.terms[t]?.term_grade ?? '';
      });
      row.getCell(8).value = { formula: `IFERROR(ROUND(AVERAGE(E${cursor}:G${cursor}),0),"")` };
      row.getCell(9).value = {
        formula: `IF(H${cursor}="","",IF(H${cursor}>89,"Advancing",IF(H${cursor}>79,"Benchmarking",IF(H${cursor}>74,"Connecting",IF(H${cursor}>64,"Developing",IF(H${cursor}>0,"Emerging",0))))))`
      };
      row.getCell(10).value = {
        formula: `IF(H${cursor}="","",IF(H${cursor}>=75,"PASSED","FAILED"))`
      };
      cursor++;
    });
  };

  writeBlock('MALE', male);
  writeBlock('FEMALE', female);

  return ws;
}

// -----------------------------------------------------------------------------
// Route
// -----------------------------------------------------------------------------
router.get('/class-record/:subjectId/export', async (req, res) => {
  try {
    const subjectId = Number(req.params.subjectId);

    const meta = await fetchMeta(pool, req.user.id, subjectId);
    if (!meta) return res.status(404).json({ error: 'Subject not found' });

    const subjectType = req.query.type || 'Core Subjects';
    const weights = SUBJECT_WEIGHTS[subjectType] || SUBJECT_WEIGHTS['Core Subjects'];

    const termRows = {};
    for (const term of [1, 2, 3]) {
      termRows[term] = await fetchTermRows(pool, req.user.id, subjectId, term);
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'RNHS Teacher Portal';
    wb.created = new Date();

    buildLookupSheet(wb);
    for (const term of [1, 2, 3]) {
      buildTermSheet(wb, term, termRows[term], meta, weights, subjectType);
    }
    buildFinalSheet(wb, termRows, meta);

    const safe = (str) => str.replace(/[^a-z0-9]+/gi, '_');
    const fileName = `ClassRecord_${safe(meta.subject_name)}_${safe(meta.section)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;