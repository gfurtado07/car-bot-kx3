import pool from './db.js';
import { addToSheet, updateSheet } from './sheets.js';
import { sendMail } from './mailer.js';
import { v4 as uuidv4 } from 'uuid';

const functions = {
  saveUser,
  createTicket, 
  getTickets,
  updateTicket,
  sendEmail,
  transcribeAudio
};

export async function functionsRouter(threadId, runId, requiredAction) {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
  const toolCalls = requiredAction.submit_tool_outputs.tool_calls;
  const toolOutputs = [];

  for (const toolCall of toolCalls) {
    const { name } = toolCall.function;
    const args = JSON.parse(toolCall.function.arguments);
    
    try {
      const result = await functions[name](args);
      toolOutputs.push({
        tool_call_id: toolCall.id,
        output: JSON.stringify(result)
      });
    } catch (error) {
      toolOutputs.push({
        tool_call_id: toolCall.id,
        output: JSON.stringify({ error: error.message })
      });
    }
  }

  await client.beta.threads.runs.submitToolOutputs(threadId, runId, {
    tool_outputs: toolOutputs
  });
}

// Functions ultra-simplificadas (só fazem o que não pode ser feito pelo Agent)
async function saveUser({ telegram_id, email, name }) {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO users (telegram_id, email, name) 
      VALUES ($1, $2, $3) 
      ON CONFLICT (telegram_id) 
      DO UPDATE SET email = $2, name = $3
    `, [telegram_id, email, name]);
    return { success: true };
  } finally {
    client.release();
  }
}

async function createTicket(data) {
  const protocol = `CAR${Date.now().toString().slice(-6)}`;
  const client = await pool.connect();
  
  try {
    await client.query(`
      INSERT INTO tickets (protocol, user_id, department, subject, description, attachments, status)
      SELECT $1, id, $3, $4, $5, $6, 'Aberto'
      FROM users WHERE telegram_id = $2
    `, [protocol, data.telegram_id, data.department, data.subject, data.description, JSON.stringify(data.attachments)]);
    
    await addToSheet({ ...data, protocol });
    return { success: true, protocol };
  } finally {
    client.release();
  }
}

async function getTickets({ telegram_id }) {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT protocol, subject, department, status, opened_at
      FROM tickets t JOIN users u ON t.user_id = u.id
      WHERE u.telegram_id = $1 AND status != 'Finalizado'
    `, [telegram_id]);
    return { tickets: result.rows };
  } finally {
    client.release();
  }
}

async function updateTicket({ protocol, status }) {
  const client = await pool.connect();
  try {
    await client.query('UPDATE tickets SET status = $1 WHERE protocol = $2', [status, protocol]);
    await updateSheet(protocol, status);
    return { success: true };
  } finally {
    client.release();
  }
}

async function sendEmail({ to, subject, html }) {
  await sendMail({ to, subject, html });
  return { success: true };
}

async function transcribeAudio({ file_id }) {
  // Implementar depois se necessário
  return { transcription: 'Transcrição em desenvolvimento' };
}
