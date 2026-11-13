// routes/classRecordExport.js
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, authorize('teacher'));

// DepEd transmutation table thresholds. The comparison is intentionally strict (>)
// to match the supplied Excel nested-IF formula exactly.
const TRANSMUTATION = [
  [99.49, 100], [98.31, 99], [97.13, 98], [95.95, 97], [94.77, 96],
  [93.59, 95], [92.41, 94], [91.23, 93], [90.05, 92], [88.87, 91],
  [87.69, 90], [86.51, 89], [85.33, 88], [84.15, 87], [82.97, 86],
  [81.79, 85], [80.61, 84], [79.43, 83], [78.25, 82], [77.07, 81],
  [75.89, 80], [74.71, 79], [73.53, 78], [72.35, 77], [71.17, 76],
  [69.99, 75], [65.33, 74], [60.66, 73], [56, 72], [51.33, 71],
  [46.66, 70], [42, 69], [37.33, 68], [32.67, 67], [28, 66],
  [23.34, 65], [18.67, 64], [14, 63], [9.34, 62], [4.67, 61], [0, 60]
];

const SUBJECT_WEIGHTS = {
  'Academic Electives': [0.20, 0.50, 0.30],
  'Arts Apprenticeship': [0.15, 0.70, 0.15],
  'Arts, Sports, Health and Wellness Electives': [0.20, 0.60, 0.20],
  'Core Subjects': [0.20, 0.50, 0.30],
  'Creative Production and Innovation': [0.15, 0.70, 0.15],
  'Design and Innovation': [0.40, 0.60, 0.00],
  'Field Exposure': [0.15, 0.70, 0.15],
  'Research Electives': [0.40, 0.60, 0.00],
  'TechPro Electives': [0.15, 0.65, 0.20],
  'Work Immersion': [0.20, 0.80, 0.00]
};

function normalizeGender(g) {
  const value = String(g || '').trim().toLowerCase();
  if (value === 'female' || value === 'f') return 'female';
  return 'male';
}

const val = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function sumValues(values) {
  return values.reduce((total, value) => total + (val(value) ?? 0), 0);
}

function transmuteGrade(initialGrade) {
  if (initialGrade === null || initialGrade === undefined || !Number.isFinite(Number(initialGrade))) {
    return null;
  }

  const grade = Number(initialGrade);
  if (grade === 0) return 0;

  for (const [threshold, transmuted] of TRANSMUTATION) {
    if (grade > threshold) return transmuted;
  }

  return 0;
}

// Calculates a term grade from the raw scores for the FINAL GRADE worksheet.
// ExcelJS writes formulas but does not evaluate them, so the final sheet needs
// this matching JavaScript calculation rather than reading an uncalculated cell.
function calculateTermGradeFromRow(row, weights) {
  const allHps = [
    row.ww1_hps, row.ww2_hps, row.ww3_hps, row.ww4_hps, row.ww5_hps,
    row.pt1_hps, row.pt2_hps, row.pt3_hps,
    row.ex1_hps, row.ex2_hps, row.ex3_hps
  ];

  // LEFT JOIN returns all-null grade fields when a learner has no grade record
  // for this term. Keep that term blank instead of treating it as a zero.
  if (allHps.every((value) => value === null || value === undefined || value === '')) {
    return null;
  }

  const wwScores = [row.ww1, row.ww2, row.ww3, row.ww4, row.ww5];
  const wwHps = [row.ww1_hps, row.ww2_hps, row.ww3_hps, row.ww4_hps, row.ww5_hps];

  const ptScores = [row.pt1, row.pt2, row.pt3];
  const ptHps = [row.pt1_hps, row.pt2_hps, row.pt3_hps];

  const exScores = [row.ex1, row.ex2, row.ex3];
  const exHps = [row.ex1_hps, row.ex2_hps, row.ex3_hps];

  const wwTotal = sumValues(wwScores);
  const wwHpsTotal = sumValues(wwHps);
  const ptTotal = sumValues(ptScores);
  const ptHpsTotal = sumValues(ptHps);
  const exTotal = sumValues(exScores);

  // Match the spreadsheet PS formulas: a zero total is displayed as a blank.
  const wwWeighted = wwTotal === 0 || wwHpsTotal === 0
    ? null
    : (wwTotal / wwHpsTotal) * 100 * weights[0];

  const ptWeighted = ptTotal === 0 || ptHpsTotal === 0
    ? null
    : (ptTotal / ptHpsTotal) * 100 * weights[1];

  let exWeighted = null;

  if (exTotal !== 0) {
    const componentWeights = [30, 30, 40];
    let examPercentage = 0;
    let validExamCalculation = true;

    for (let i = 0; i < 3; i++) {
      const score = val(exScores[i]) ?? 0;
      const hps = val(exHps[i]) ?? 0;

      if (hps === 0) {
        validExamCalculation = false;
        break;
      }

      examPercentage += (score / hps) * componentWeights[i];
    }

    if (validExamCalculation) {
      exWeighted = examPercentage * weights[2];
    }
  }

  // The supplied Initial Grade formula checks only WW WS and PT WS for zero.
  // Blank text results are ignored by Excel SUM, so missing components contribute 0.
  if (wwWeighted === 0 || ptWeighted === 0) return null;

  const initialGrade =
    (wwWeighted ?? 0) +
    (ptWeighted ?? 0) +
    (exWeighted ?? 0);

  return transmuteGrade(initialGrade);
}

async function fetchTermRows(db, teacherId, subjectId, term) {
  const [rows] = await db.query(`
    SELECT
      u.id AS student_id,
      u.full_name,
      s.lrn,
      s.gender,

      g.ww1, g.ww2, g.ww3, g.ww4, g.ww5,
      g.pt1, g.pt2, g.pt3,
      g.ex1, g.ex2, g.ex3,

      g.ww1_hps, g.ww2_hps, g.ww3_hps, g.ww4_hps, g.ww5_hps,
      g.pt1_hps, g.pt2_hps, g.pt3_hps,
      g.ex1_hps, g.ex2_hps, g.ex3_hps

    FROM subjects sub
    JOIN sections sec ON sec.id = sub.section_id
    JOIN students s ON s.section_id = sec.id
    JOIN users u ON u.id = s.user_id

    LEFT JOIN grades g
      ON g.student_id = u.id
      AND g.subject_id = sub.id
      AND g.term = ?

    WHERE sub.teacher_id = ? AND sub.id = ?
    ORDER BY u.full_name
  `, [term, teacherId, subjectId]);

  return rows;
}

async function fetchMeta(db, teacherId, subjectId) {
  const [[meta]] = await db.query(`
    SELECT
      sub.name AS subject_name,
      sec.name AS section,
      u.full_name AS teacher_name

    FROM subjects sub
    JOIN sections sec ON sec.id = sub.section_id
    JOIN users u ON u.id = sub.teacher_id

    WHERE sub.teacher_id = ? AND sub.id = ?
  `, [teacherId, subjectId]);

  return meta;
}

function setFormula(cell, formula) {
  cell.value = { formula };
}

function buildTermSheet(wb, term, rows, meta, weights, subjectType) {
  const ws = wb.addWorksheet(`TERM ${term}`, {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 16 }]
  });

  const widths = {
    A: 6, B: 32, C: 6, D: 6, E: 6, F: 6, G: 6, H: 8, I: 8, J: 8,
    K: 6, L: 6, M: 6, N: 8, O: 8, P: 8, Q: 6, R: 6, S: 6, T: 8,
    U: 8, V: 8, W: 12, X: 12, Y: 15
  };

  Object.entries(widths).forEach(([column, width]) => {
    ws.getColumn(column).width = width;
  });

  // Main heading and school information.
  ws.mergeCells('A1:Y1');
  ws.getCell('A1').value = `CLASS RECORD - TERM ${term}`;
  ws.getCell('A1').font = { bold: true, size: 14 };

  ws.mergeCells('A3:Y3');
  ws.getCell('A3').value = '(Pursuant to DepEd Order 15 series of 2026)';
  ws.getCell('A3').font = {
    italic: true,
    size: 10,
    color: { argb: 'FF666666' }
  };

  ws.getCell('C5').value = 'REGION:';
  ws.getCell('H5').value = 'I';
  ws.getCell('N5').value = 'DIVISION';
  ws.getCell('Q5').value = 'PANGASINAN II';
  ws.getCell('T5').value = 'SCHOOL ID';
  ws.getCell('W5').value = '300341';

  ws.getCell('C7').value = 'SCHOOL NAME:';
  ws.getCell('H7').value = 'ROSALES NATIONAL HIGH SCHOOL';
  ws.getCell('S7').value = 'SCHOOL YEAR:';
  ws.getCell('W7').value = '2026-2027';

  ws.getCell('A10').value = `TERM ${term}`;
  ws.getCell('C10').value = 'GRADE LEVEL';
  ws.getCell('I10').value = '11';
  ws.getCell('N10').value = 'TEACHER:';
  ws.getCell('Q10').value = meta.teacher_name;
  ws.getCell('U10').value = 'SUBJECT:';
  ws.getCell('W10').value = meta.subject_name;

  ws.getCell('C11').value = 'SECTION';
  ws.getCell('I11').value = meta.section;
  ws.getCell('N11').value = 'TRACK:';
  ws.getCell('Q11').value = 'ACADEMIC';
  ws.getCell('U11').value = 'SUBJECT TYPE:';
  ws.getCell('W11').value = subjectType;

  // Exact-match VLOOKUP avoids incorrect weights if the lookup table is reordered.
  setFormula(ws.getCell('C13'), 'VLOOKUP(W11,Sheet2!A2:D11,2,FALSE)');
  setFormula(ws.getCell('K13'), 'VLOOKUP(W11,Sheet2!A2:D11,3,FALSE)');
  setFormula(ws.getCell('Q13'), 'VLOOKUP(W11,Sheet2!A2:D11,4,FALSE)');

  ws.mergeCells('C12:J12');
  ws.getCell('C12').value = 'WRITTEN/ORAL WORKS (WWs)';
  ws.getCell('C12').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E7FF' }
  };
  ws.getCell('C12').font = { bold: true };

  ws.mergeCells('K12:P12');
  ws.getCell('K12').value = 'PRODUCT/PERFORMANCE TASKS (PTs)';
  ws.getCell('K12').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFDCFCE7' }
  };
  ws.getCell('K12').font = { bold: true };

  ws.mergeCells('Q12:V12');
  ws.getCell('Q12').value = 'EXAMINATIONS (EXs)';
  ws.getCell('Q12').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFEF3C7' }
  };
  ws.getCell('Q12').font = { bold: true };

  ['1', '2', '3', '4', '5', 'TOTAL', 'PS', 'WS'].forEach((heading, index) => {
    const cell = ws.getRow(14).getCell(3 + index);
    cell.value = heading;
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center' };
  });

  ['1', '2', '3', 'TOTAL', 'PS', 'WS'].forEach((heading, index) => {
    const cell = ws.getRow(14).getCell(11 + index);
    cell.value = heading;
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center' };
  });

  ['SA1', 'SA2', 'TE', 'TOTAL', 'PS', 'WS'].forEach((heading, index) => {
    const cell = ws.getRow(14).getCell(17 + index);
    cell.value = heading;
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center' };
  });

  ws.getCell('B15').value = 'HIGHEST POSSIBLE SCORE';
  ws.getCell('B15').font = { bold: true };

  const hpsRef = rows[0] || {};

  ['ww1_hps', 'ww2_hps', 'ww3_hps', 'ww4_hps', 'ww5_hps'].forEach((field, index) => {
    ws.getRow(15).getCell(3 + index).value = val(hpsRef[field]) ?? 100;
  });

  setFormula(ws.getCell('H15'), 'SUM(C15:G15)');
  ws.getCell('I15').value = 100;
  setFormula(ws.getCell('J15'), 'I15*$C$13');

  ['pt1_hps', 'pt2_hps', 'pt3_hps'].forEach((field, index) => {
    ws.getRow(15).getCell(11 + index).value = val(hpsRef[field]) ?? 100;
  });

  setFormula(ws.getCell('N15'), 'SUM(K15:M15)');
  ws.getCell('O15').value = 100;
  setFormula(ws.getCell('P15'), 'O15*$K$13');

  ['ex1_hps', 'ex2_hps', 'ex3_hps'].forEach((field, index) => {
    ws.getRow(15).getCell(17 + index).value = val(hpsRef[field]) ?? 100;
  });

  setFormula(ws.getCell('T15'), 'SUM(Q15:S15)');
  ws.getCell('U15').value = 100;
  setFormula(ws.getCell('V15'), 'U15*$Q$13');

  ws.getCell('B16').value = "LEARNERS' NAMES";
  ws.getCell('B16').font = { bold: true };
  ws.getCell('W16').value = 'Initial Grade';
  ws.getCell('X16').value = 'Term Grade';
  ws.getCell('Y16').value = 'Descriptor';
  ws.getRow(16).font = { bold: true };

  const male = rows.filter((row) => normalizeGender(row.gender) === 'male');
  const female = rows.filter((row) => normalizeGender(row.gender) === 'female');

  let cursor = 17;
  let maleStartRow = null;
  let maleEndRow = null;
  let femaleStartRow = null;
  let femaleEndRow = null;

  const writeBlock = (label, list) => {
    ws.getCell(`A${cursor}`).value = label;
    ws.getCell(`A${cursor}`).font = { bold: true, italic: true };
    cursor++;

    const firstStudentRow = cursor;

    list.forEach((student, index) => {
      const rowNumber = cursor;
      const row = ws.getRow(rowNumber);

      row.getCell(1).value = index + 1;
      row.getCell(2).value = student.full_name;

      row.getCell(3).value = val(student.ww1);
      row.getCell(4).value = val(student.ww2);
      row.getCell(5).value = val(student.ww3);
      row.getCell(6).value = val(student.ww4);
      row.getCell(7).value = val(student.ww5);

      setFormula(row.getCell(8), `SUM(C${rowNumber}:G${rowNumber})`);
      setFormula(row.getCell(9), `IF(OR(H${rowNumber}=0)," ",H${rowNumber}/$H$15*100)`);
      setFormula(row.getCell(10), `IFERROR(IF(OR(H${rowNumber}=" ")," ",I${rowNumber}*$C$13)," ")`);

      row.getCell(11).value = val(student.pt1);
      row.getCell(12).value = val(student.pt2);
      row.getCell(13).value = val(student.pt3);

      setFormula(row.getCell(14), `SUM(K${rowNumber}:M${rowNumber})`);
      setFormula(row.getCell(15), `IF(OR(N${rowNumber}=0)," ",N${rowNumber}/$N$15*100)`);
      setFormula(row.getCell(16), `IFERROR(O${rowNumber}*$K$13," ")`);

      row.getCell(17).value = val(student.ex1);
      row.getCell(18).value = val(student.ex2);
      row.getCell(19).value = val(student.ex3);

      setFormula(row.getCell(20), `SUM(Q${rowNumber}:S${rowNumber})`);
      setFormula(
        row.getCell(21),
        `IFERROR(IF(T${rowNumber}=0," ",((Q${rowNumber}/$Q$15*30)+(R${rowNumber}/$R$15*30)+(S${rowNumber}/$S$15*40)))," ")`
      );
      setFormula(row.getCell(22), `IFERROR(U${rowNumber}*$Q$13," ")`);

      setFormula(
        row.getCell(23),
        `IF(OR(J${rowNumber}=0,P${rowNumber}=0)," ",SUM(J${rowNumber},P${rowNumber},V${rowNumber}))`
      );

      // Same transmutation thresholds and descriptor boundaries as the supplied formulas.
      const transmutationFormula =
        `IF(W${rowNumber}=" "," ",IF(W${rowNumber}>99.49,100,IF(W${rowNumber}>98.31,99,IF(W${rowNumber}>97.13,98,IF(W${rowNumber}>95.95,97,IF(W${rowNumber}>94.77,96,IF(W${rowNumber}>93.59,95,IF(W${rowNumber}>92.41,94,IF(W${rowNumber}>91.23,93,IF(W${rowNumber}>90.05,92,IF(W${rowNumber}>88.87,91,IF(W${rowNumber}>87.69,90,IF(W${rowNumber}>86.51,89,IF(W${rowNumber}>85.33,88,IF(W${rowNumber}>84.15,87,IF(W${rowNumber}>82.97,86,IF(W${rowNumber}>81.79,85,IF(W${rowNumber}>80.61,84,IF(W${rowNumber}>79.43,83,IF(W${rowNumber}>78.25,82,IF(W${rowNumber}>77.07,81,IF(W${rowNumber}>75.89,80,IF(W${rowNumber}>74.71,79,IF(W${rowNumber}>73.53,78,IF(W${rowNumber}>72.35,77,IF(W${rowNumber}>71.17,76,IF(W${rowNumber}>69.99,75,IF(W${rowNumber}>65.33,74,IF(W${rowNumber}>60.66,73,IF(W${rowNumber}>56,72,IF(W${rowNumber}>51.33,71,IF(W${rowNumber}>46.66,70,IF(W${rowNumber}>42,69,IF(W${rowNumber}>37.33,68,IF(W${rowNumber}>32.67,67,IF(W${rowNumber}>28,66,IF(W${rowNumber}>23.34,65,IF(W${rowNumber}>18.67,64,IF(W${rowNumber}>14,63,IF(W${rowNumber}>9.34,62,IF(W${rowNumber}>4.67,61,IF(W${rowNumber}>0,60,IF(W${rowNumber}=0,0)))))))))))))))))))))))))))))))))))))))))`;

      setFormula(row.getCell(24), transmutationFormula);

      setFormula(
        row.getCell(25),
        `IF(X${rowNumber}=" "," ",IF(X${rowNumber}>89,"Advancing",IF(X${rowNumber}>79,"Benchmarking",IF(X${rowNumber}>74,"Connecting",IF(X${rowNumber}>64,"Developing",IF(X${rowNumber}>0,"Emerging",0))))))`
      );

      cursor++;
    });

    return {
      startRow: list.length > 0 ? firstStudentRow : null,
      endRow: list.length > 0 ? cursor - 1 : null
    };
  };

  const maleRows = writeBlock('MALE', male);
  maleStartRow = maleRows.startRow;
  maleEndRow = maleRows.endRow;

  const femaleRows = writeBlock('FEMALE', female);
  femaleStartRow = femaleRows.startRow;
  femaleEndRow = femaleRows.endRow;

  // Signature block.
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

  // --- STUDENTS' PERFORMANCE PROFILE ---
  const pStart = sig + 5;

  ws.getCell(`B${pStart}`).value = "STUDENTS' PERFORMANCE PROFILE";
  ws.getCell(`B${pStart}`).font = { bold: true };

  const pHeader = pStart + 1;

  const profileHeaders = [
    'LEVEL OF PROFICIENCY', 'MALE', '', '%', '',
    'FEMALE', '', '%', 'TOTAL', '%'
  ];

  profileHeaders.forEach((heading, index) => {
    const cell = ws.getCell(pHeader, 2 + index);
    cell.value = heading;
    cell.font = { bold: true };
  });

  const levels = [
    'Advancing',
    'Benchmarking',
    'Connecting',
    'Developing',
    'Emerging'
  ];

  const maleRange = maleStartRow !== null
    ? `$Y$${maleStartRow}:$Y$${maleEndRow}`
    : null;

  const femaleRange = femaleStartRow !== null
    ? `$Y$${femaleStartRow}:$Y$${femaleEndRow}`
    : null;

  levels.forEach((level, index) => {
    const rowNumber = pHeader + 1 + index;

    ws.getCell(rowNumber, 2).value = level;

    setFormula(
      ws.getCell(rowNumber, 3),
      maleRange ? `COUNTIF(${maleRange},"${level}")` : '0'
    );

    setFormula(
      ws.getCell(rowNumber, 5),
      `IFERROR(C${rowNumber}/SUM($C$${pHeader + 1}:$C$${pHeader + 5})*100," ")`
    );

    setFormula(
      ws.getCell(rowNumber, 7),
      femaleRange ? `COUNTIF(${femaleRange},"${level}")` : '0'
    );

    setFormula(
      ws.getCell(rowNumber, 9),
      `IFERROR(G${rowNumber}/SUM($G$${pHeader + 1}:$G$${pHeader + 5})*100," ")`
    );

    setFormula(
      ws.getCell(rowNumber, 10),
      `SUM(C${rowNumber},G${rowNumber})`
    );

    setFormula(
      ws.getCell(rowNumber, 11),
      `IFERROR(J${rowNumber}/SUM($J$${pHeader + 1}:$J$${pHeader + 5})*100," ")`
    );
  });

  // --- BASIC STATISTICS ---
  ws.getCell(`P${pHeader}`).value = 'BASIC STATISTICS';
  ws.getCell(`P${pHeader}`).font = { bold: true };

  ws.getCell(`Q${pHeader}`).value = 'SA1';
  ws.getCell(`R${pHeader}`).value = 'SA2';
  ws.getCell(`S${pHeader}`).value = 'TE';
  ws.getCell(`T${pHeader}`).value = 'PASSED';

  setFormula(
    ws.getCell(`U${pHeader}`),
    `SUM(J${pHeader + 1}:J${pHeader + 3})`
  );

  ws.getCell(`P${pHeader + 1}`).value = 'EXAMS';
  ws.getCell(`Q${pHeader + 1}`).value = 'MEAN';
  ws.getCell(`U${pHeader + 1}`).value = 'FAILED';

  const examRanges = (column) => {
    const ranges = [];

    if (maleStartRow !== null) {
      ranges.push(`${column}${maleStartRow}:${column}${maleEndRow}`);
    }

    if (femaleStartRow !== null) {
      ranges.push(`${column}${femaleStartRow}:${column}${femaleEndRow}`);
    }

    return ranges;
  };

  // R/S/T contain the means for SA1/SA2/TE, respectively.
  ['Q', 'R', 'S'].forEach((column, index) => {
    const targetColumn = ['R', 'S', 'T'][index];
    const ranges = examRanges(column);

    setFormula(
      ws.getCell(`${targetColumn}${pHeader + 1}`),
      ranges.length
        ? `IFERROR(AVERAGE(${ranges.join(',')})," ")`
        : '" "'
    );
  });

  // Passed = Advancing + Benchmarking + Connecting (75 and above).
  // Failed = Developing + Emerging (below 75).
  setFormula(
    ws.getCell(`V${pHeader + 1}`),
    `SUM(J${pHeader + 4}:J${pHeader + 5})`
  );

  ws.getCell(`P${pHeader + 2}`).value = 'MPS';

  setFormula(
    ws.getCell(`Q${pHeader + 2}`),
    `IFERROR(R${pHeader + 1}/Q15," ")`
  );

  setFormula(
    ws.getCell(`R${pHeader + 2}`),
    `IFERROR(S${pHeader + 1}/R15," ")`
  );

  setFormula(
    ws.getCell(`S${pHeader + 2}`),
    `IFERROR(T${pHeader + 1}/S15," ")`
  );

  // Keep the workbook readable and print-friendly.
  [pStart, pHeader].forEach((rowNumber) => {
    ws.getRow(rowNumber).font = { bold: true };
  });

  ws.autoFilter = {
    from: 'A16',
    to: 'Y16'
  };
}

function buildLookupSheet(wb) {
  const ws = wb.addWorksheet('Sheet2');

  ws.getColumn('A').width = 55;
  ws.getColumn('B').width = 8;
  ws.getColumn('C').width = 8;
  ws.getColumn('D').width = 8;

  ws.getRow(1).values = ['SUBJECT TYPE', 'WWs', 'PTs', 'EXs'];
  ws.getRow(1).font = { bold: true };

  Object.entries(SUBJECT_WEIGHTS).forEach(([name, weights], index) => {
    ws.getRow(index + 2).values = [
      name,
      weights[0],
      weights[1],
      weights[2]
    ];
  });
}

function buildFinalSheet(wb, termRows, meta, weights) {
  const studentMap = new Map();

  for (const term of [1, 2, 3]) {
    for (const row of termRows[term] || []) {
      if (!studentMap.has(row.student_id)) {
        studentMap.set(row.student_id, {
          full_name: row.full_name,
          gender: normalizeGender(row.gender),
          terms: {}
        });
      }

      studentMap.get(row.student_id).terms[term] = row;
    }
  }

  const ws = wb.addWorksheet('FINAL GRADE');

  ws.getColumn('A').width = 6;
  ws.getColumn('B').width = 32;
  ws.getColumn('E').width = 12;
  ws.getColumn('F').width = 12;
  ws.getColumn('G').width = 12;
  ws.getColumn('H').width = 15;
  ws.getColumn('I').width = 18;
  ws.getColumn('J').width = 15;

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

  ws.getRow(12).values = [
    '', '', '', '', 'TERM GRADES', '', '',
    'FINAL GRADE', 'DESCRIPTOR', 'REMARK'
  ];
  ws.getRow(12).font = { bold: true };

  ws.getRow(13).values = [
    '', '', '', '', 'TERM 1', 'TERM 2', 'TERM 3', '', '', ''
  ];
  ws.getRow(13).font = { bold: true };

  const male = [];
  const female = [];

  for (const [, student] of studentMap) {
    (student.gender === 'female' ? female : male).push(student);
  }

  let cursor = 14;

  const writeBlock = (label, list) => {
    ws.getCell(`A${cursor}`).value = label;
    ws.getCell(`A${cursor}`).font = { bold: true, italic: true };
    cursor++;

    list.forEach((student, index) => {
      const rowNumber = cursor;
      const row = ws.getRow(rowNumber);

      row.getCell(1).value = index + 1;
      row.getCell(2).value = student.full_name;

      [1, 2, 3].forEach((term, termIndex) => {
        const termRow = student.terms[term];

        row.getCell(5 + termIndex).value = termRow
          ? calculateTermGradeFromRow(termRow, weights)
          : null;
      });

      setFormula(
        row.getCell(8),
        `IFERROR(ROUND(AVERAGE(E${rowNumber}:G${rowNumber}),0),"")`
      );

      setFormula(
        row.getCell(9),
        `IF(H${rowNumber}="","",IF(H${rowNumber}>89,"Advancing",IF(H${rowNumber}>79,"Benchmarking",IF(H${rowNumber}>74,"Connecting",IF(H${rowNumber}>64,"Developing",IF(H${rowNumber}>0,"Emerging",0))))))`
      );

      setFormula(
        row.getCell(10),
        `IF(H${rowNumber}="","",IF(H${rowNumber}>=75,"PASSED","FAILED"))`
      );

      cursor++;
    });
  };

  writeBlock('MALE', male);
  writeBlock('FEMALE', female);
}

router.get('/class-record/:subjectId/export', async (req, res) => {
  try {
    const subjectId = Number(req.params.subjectId);

    if (!Number.isInteger(subjectId) || subjectId <= 0) {
      return res.status(400).json({ error: 'Invalid subject ID' });
    }

    const meta = await fetchMeta(pool, req.user.id, subjectId);

    if (!meta) {
      return res.status(404).json({ error: 'Subject not found' });
    }

    const subjectType = req.query.type || 'Core Subjects';
    const weights = SUBJECT_WEIGHTS[subjectType] || SUBJECT_WEIGHTS['Core Subjects'];

    const termRows = {};

    for (const term of [1, 2, 3]) {
      termRows[term] = await fetchTermRows(
        pool,
        req.user.id,
        subjectId,
        term
      );
    }

    const wb = new ExcelJS.Workbook();

    wb.creator = 'RNHS Teacher Portal';
    wb.created = new Date();
    wb.modified = new Date();

    // ExcelJS stores formulas but does not calculate them. Ask Excel to recalculate
    // all formula cells when the user opens the exported workbook.
    wb.calcProperties = {
      calcMode: 'auto',
      fullCalcOnLoad: true,
      forceFullCalc: true
    };

    buildLookupSheet(wb);

    for (const term of [1, 2, 3]) {
      buildTermSheet(
        wb,
        term,
        termRows[term],
        meta,
        weights,
        subjectType
      );
    }

    buildFinalSheet(wb, termRows, meta, weights);

    const safe = (value) =>
      String(value || 'ClassRecord').replace(/[^a-z0-9]+/gi, '_');

    const fileName =
      `ClassRecord_${safe(meta.subject_name)}_${safe(meta.section)}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"`
    );

    res.setHeader('Cache-Control', 'no-store');

    await wb.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Class record export error:', error);

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to export class record',
        details: error.message
      });
    } else {
      res.end();
    }
  }
});

module.exports = router;