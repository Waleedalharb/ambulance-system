const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const employees = [
    { code: '4252', name: 'سلطان ابراهيم يوسف اليوسف التميمي' },
    { code: '101353', name: 'هيثم حويكم هليل العنزي' },
    { code: '102462', name: 'وليد معلا الحربي' },
    { code: '11120', name: 'عوض عبدالعزيز عوض الاسمري' },
    { code: '102752', name: 'محمد نايف صنهات العتيبي' },
    { code: '10717', name: 'عطاالله خالد عطوي الرويلي' },
    { code: '101915', name: 'مبارك هذال مبارك ال بريك' },
    { code: '8323', name: 'تركي عتيق الله خيرالله المطيري' },
    { code: '10373', name: 'سامي صالح عناد العنزي' },
    { code: '6182', name: 'مشعل علي هديرس الحجيلي' },
    { code: '9666', name: 'راشد محمد راشد الخرعان' },
    { code: '11079', name: 'مبارك محسن مبارك العجمي' },
    { code: '8745', name: 'خالد محمد عبدالمجيد العياضي' },
    { code: '7454', name: 'عادل خليف دخيل المطيري' },
    { code: '692', name: 'فواز حميد خلاف الظفيري' },
    { code: '61277', name: 'زياد سعيد جبران الشهراني' },
    { code: '8968', name: 'موسى علي احمد غروي' },
    { code: '61296', name: 'سامي منور عبدالله المطيري' },
    { code: '6263', name: 'عبدالرحمن نائف مضحي الحربي' },
];

function generateRandomPassword(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

function main() {
    const users = [];
    const tempPasswords = [];

    console.log('========================================');
    console.log('   Employee Temporary Passwords');
    console.log('========================================');
    console.log('');

    for (const emp of employees) {
        const tempPassword = generateRandomPassword(8);
        const hash = bcrypt.hashSync(tempPassword, 10);

        users.push({
            id: 'emp-' + emp.code,
            username: emp.code,
            name: emp.name,
            password: hash,
            role: 'admin',
            isActive: true
        });

        tempPasswords.push({
            code: emp.code,
            name: emp.name,
            password: tempPassword
        });

        console.log(`Code: ${emp.code} | Password: ${tempPassword} | Name: ${emp.name}`);
    }

    console.log('');
    console.log('========================================');
    console.log(`Total employees: ${users.length}`);
    console.log('========================================');

    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const outputPath = path.join(dataDir, 'users.json');
    fs.writeFileSync(outputPath, JSON.stringify(users, null, 2), 'utf8');
    console.log(`\nUsers saved to: ${outputPath}`);
    console.log(`File size: ${fs.statSync(outputPath).size} bytes`);
}

main();
