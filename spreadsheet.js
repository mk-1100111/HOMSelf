const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
    keyFile: './google.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function writeToSheet(values) {
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = '18rvJ-rP-E6s8VqriaJwPboJZiFK68f8f35JNrzNrYbM';
    const range = 'log!A1'; 
    const valueInputOption = 'USER_ENTERED';

    const resource = { values };

    try {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range,
            valueInputOption,
            resource
        });
        return resource;
    } catch (error) {
        console.error('error', error);
    }
}

(async () => {
    const writer = await writeToSheet([['material_code','manager_name','quantity']]);
    console.log(writer);
})();
