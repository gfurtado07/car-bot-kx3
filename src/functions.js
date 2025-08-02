import pool from './db.js';
import { addTicketToSheet, updateTicketStatusInSheet } from './sheets.js';
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
    
    console.log(`🔧 Executando: ${name}`, args);
    
    try {
      const result = await functions[name](args);
      console.log(`✅ ${name} executado com sucesso`);
      toolOutputs.push({
        tool_call_id: toolCall.id,
        output: JSON.stringify(result)
      });
    } catch (error) {
      console.error(`❌ Erro em ${name}:`, error);
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

// ===== FUNCTIONS SIMPLIFICADAS =====

async function saveUser({ telegram_id, email, name }) {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO users (telegram_id, email, name) 
      VALUES ($1, $2, $3) 
      ON CONFLICT (telegram_id) 
      DO UPDATE SET email = $2, name = $3
    `, [telegram_id, email, name]);
    
    console.log(`👤 Usuário salvo: ${name} (${email})`);
    return { success: true, message: 'Dados salvos com sucesso!' };
  } catch (error) {
    console.error('❌ Erro ao salvar usuário:', error);
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}

async function createTicket({ telegram_id, department, subject, description, attachments = [] }) {
  const protocol = `CAR${Date.now().toString().slice(-6)}`;
  const client = await pool.connect();
  
  try {
    // Buscar usuário
    const userResult = await client.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
    if (userResult.rows.length === 0) {
      return { success: false, error: 'Usuário não encontrado. Cadastre-se primeiro.' };
    }
    
    const user = userResult.rows[0];
    
    // Salvar ticket no banco
    await client.query(`
      INSERT INTO tickets (protocol, user_id, department, subject, description, attachments, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'Aberto')
    `, [protocol, user.id, department, subject, description, JSON.stringify(attachments)]);
    
    // Adicionar à planilha
    try {
      await addTicketToSheet({
        protocol,
        user_name: user.name || 'Representante',
        email: user.email,
        department,
        subject,
        description,
        status: 'Aberto',
        attachment_links: attachments.map(a => a.url).join(', ') || 'Nenhum'
      });
    } catch (sheetError) {
      console.error('⚠️ Erro na planilha:', sheetError.message);
      // Não falha o ticket por erro na planilha
    }
    
    console.log(`🎫 Ticket criado: ${protocol}`);
    return { 
      success: true, 
      protocol,
      user_name: user.name,
      user_email: user.email
    };
    
  } catch (error) {
    console.error('❌ Erro ao criar ticket:', error);
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}

async function getTickets({ telegram_id }) {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT t.protocol, t.subject, t.department, t.status, t.opened_at
      FROM tickets t
      JOIN users u ON t.user_id = u.id
      WHERE u.telegram_id = $1 AND t.status != 'Finalizado'
      ORDER BY t.opened_at DESC
    `, [telegram_id]);
    
    console.log(`📋 ${result.rows.length} tickets encontrados para usuário ${telegram_id}`);
    return { success: true, tickets: result.rows };
  } catch (error) {
    console.error('❌ Erro ao buscar tickets:', error);
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}

async function updateTicket({ protocol, status }) {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      UPDATE tickets 
      SET status = $1, closed_at = CASE WHEN $1 = 'Finalizado' THEN NOW() ELSE closed_at END
      WHERE protocol = $2
      RETURNING *
    `, [status, protocol]);
    
    if (result.rows.length === 0) {
      return { success: false, error: 'Chamado não encontrado.' };
    }
    
    // Atualizar planilha
    try {
      await updateTicketStatusInSheet(protocol, status);
    } catch (sheetError) {
      console.error('⚠️ Erro ao atualizar planilha:', sheetError.message);
    }
    
    console.log(`🔄 Ticket ${protocol} atualizado para: ${status}`);
    return { success: true, message: `Chamado ${protocol} ${status.toLowerCase()} com sucesso!` };
  } catch (error) {
    console.error('❌ Erro ao atualizar ticket:', error);
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}

async function sendEmail({ to, subject, html }) {
  try {
    await sendMail({ to, subject, html });
    console.log(`📧 Email enviado para: ${to}`);
    return { success: true, message: 'Email enviado com sucesso!' };
  } catch (error) {
    console.error('❌ Erro ao enviar email:', error);
    return { success: false, error: error.message };
  }
}

async function transcribeAudio({ file_id }) {
  // TODO: Implementar transcrição de áudio
  console.log(`🎤 Transcrição solicitada para: ${file_id}`);
  return { 
    success: true, 
    transcription: '[Transcrição de áudio será implementada em breve]' 
  };
}

export default functions;
