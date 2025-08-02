import { google } from 'googleapis';
import dotenv from 'dotenv';
dotenv.config();

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

export async function addTicketToSheet(ticketData) {
  try {
    const values = [[
      ticketData.protocol,
      new Date().toLocaleString('pt-BR'),
      ticketData.user_name || 'N/A',
      ticketData.email || 'N/A',
      ticketData.department,
      ticketData.subject,
      ticketData.description,
      ticketData.status || 'Aberto',
      ticketData.attachment_links || ''
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'A:I',
      valueInputOption: 'RAW',
      requestBody: { values }
    });

    console.log('Ticket adicionado à planilha:', ticketData.protocol);
  } catch (error) {
    console.error('Erro ao adicionar à planilha:', error);
  }
}

export async function updateTicketStatusInSheet(protocol, newStatus) {
  try {
    // Buscar linha do protocolo
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'A:H'
    });

    const rows = response.data.values;
    const rowIndex = rows.findIndex(row => row[0] === protocol);
    
    if (rowIndex > 0) { // > 0 porque linha 0 é cabeçalho
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `H${rowIndex + 1}`, // +1 porque sheets começa em 1
        valueInputOption: 'RAW',
        requestBody: {
          values: [[newStatus]]
        }
      });
      console.log('Status atualizado na planilha:', protocol, newStatus);
    }
  } catch (error) {
    console.error('Erro ao atualizar status na planilha:', error);
  }
}
