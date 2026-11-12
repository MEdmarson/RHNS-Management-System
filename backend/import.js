const fs = require('fs');
const csv = require('csv-parser');
const pool = require('./config/db');
const bcrypt = require('bcryptjs');

const fileName = process.argv[2];
const sectionName = process.argv[3];

if (!fileName || !sectionName) {
  console.error("❌ Error: Missing arguments.");
  console.log("👉 Usage: node import.js <filename.csv> \"<Section Name>\"");
  process.exit(1);
}

const results = [];

console.log(`📂 Reading file: ${fileName}`);
console.log(`🏫 Assigning to section: ${sectionName}`);

fs.createReadStream(fileName)
  .pipe(csv({ headers: false })) 
  .on('data', (data) => {
    const name = data['1'];
    const lrn = data['2'];

    // Only process rows that have a valid LRN and a name
    if (lrn && lrn.trim().length >= 10 && name && name.trim() !== 'MALE' && name.trim() !== 'FEMALE') {
      results.push({ name: name.trim(), lrn: lrn.trim() });
    }
  })
  .on('end', async () => {
    console.log(`Found ${results.length} students. Starting import...`);

    try {
      let section_id;
      const [sec] = await pool.query('SELECT id FROM sections WHERE name = ?', [sectionName]);
      if (sec.length) {
        section_id = sec[0].id;
      } else {
        const [ins] = await pool.query('INSERT INTO sections (name) VALUES (?)', [sectionName]);
        section_id = ins.insertId;
      }

      let successCount = 0;
      let failCount = 0;

      for (const student of results) {
        try {
          const defaultPassword = student.lrn; 
          const password_hash = await bcrypt.hash(defaultPassword, 10);

          // STUDENT: email is explicitly set to NULL
          const [userResult] = await pool.query(
            'INSERT INTO users (full_name, email, lrn, password_hash, role, is_first_login) VALUES (?, NULL, ?, ?, "student", TRUE)',
            [student.name, student.lrn, password_hash]
          );
          
          const user_id = userResult.insertId;

          await pool.query(
            'INSERT INTO students (user_id, lrn, section_id, grade_level) VALUES (?, ?, ?, 12)',
            [user_id, student.lrn, section_id]
          );

          console.log(`  ✅ Imported Student: ${student.name} (Login: ${student.lrn})`);
          successCount++;
        } catch (err) {
          if (err.code === 'ER_DUP_ENTRY') {
            console.log(`  ⚠️  Skipped: ${student.name} (LRN already exists)`);
          } else {
            console.error(`  ❌ Failed: ${student.name} - ${err.message}`);
          }
          failCount++;
        }
      }
      
      console.log(`\n🏁 Import Complete! Success: ${successCount}, Failed: ${failCount}`);
      process.exit();
    } catch (err) {
      console.error("❌ Database Error:", err);
      process.exit(1);
    }
  });