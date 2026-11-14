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
let currentGender = 'male'; // Default

console.log(`📂 Reading file: ${fileName}`);
console.log(`🏫 Assigning to section: ${sectionName}`);

fs.createReadStream(fileName)
  .pipe(csv({ headers: false })) 
  .on('data', (data) => {
    // The name is in Column B (index 1)
    // The LRN is in Column C (index 2)
    const colB = (data['1'] || '').trim(); 
    const colC = (data['2'] || '').trim(); 

    // 1. Check if Column B is the "MALE" or "FEMALE" indicator
    if (colB.toUpperCase() === 'MALE') {
      currentGender = 'male';
      return;
    }
    if (colB.toUpperCase() === 'FEMALE') {
      currentGender = 'female';
      return;
    }

    // 2. Skip the header row (where Column B is "NAME")
    if (colB.toUpperCase() === 'NAME') {
      return;
    }

    // 3. If Column C has a valid LRN and Column B has a Name, save it
    if (colC && colC.length >= 10 && colB && colB !== '') {
      results.push({ 
        name: colB, 
        lrn: colC, 
        gender: currentGender 
      });
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

          // Insert into users table
          const [userResult] = await pool.query(
            'INSERT INTO users (full_name, email, password_hash, role, is_first_login) VALUES (?, NULL, ?, "student", TRUE)',
            [student.name, password_hash]
          );
          
          const user_id = userResult.insertId;

          // Insert into students table (INCLUDING GENDER)
          await pool.query(
            'INSERT INTO students (user_id, lrn, section_id, grade_level, gender) VALUES (?, ?, ?, 11, ?)',
            [user_id, student.lrn, section_id, student.gender]
          );

          console.log(`  ✅ Imported ${student.gender.toUpperCase()}: ${student.name}`);
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