
const bcrypt = require('bcrypt');

async function generateHash() {
    const password = 'Admin@123@';

    const saltRounds = 12;

    const hashedPassword = await bcrypt.hash(password, saltRounds);

    console.log('Original password:', password);
    console.log('Hashed password:', hashedPassword);
}

generateHash();
