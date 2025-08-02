import pool from './db.js';
import { addTicketToSheet, updateTicketStatusInSheet } from './sheets.js';
import { sendMail } from './mailer.js';
import { uploadAttachments } from './storage.js';
import { log, logError } from './utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

// Mapeamento das functions disponíveis para o Assistant
const functions = {
  addUserEmail,
  getDepartments,
  openTicket,
  listTickets,
  getTicketDetail,
  closeTicket,
  replyTicket,
  transcribeAudio
};

export async function functionsRouter(threadId, runId, requiredAction) {
  const openai = (await import('openai')).default;
  const client = new openai({ apiKey: process.env.OPENAI_API_KEY });

  const toolCalls = requiredAction.submit_tool_outputs.tool_calls;
  const toolOutputs = [];

  for (const toolCall of toolCalls) {
    const functionName = toolCall.function.name;
    const functionArgs = JSON.parse(toolCall.function.arguments);
    
    log(`Executando function: ${functionName}`, functionArgs);

    try {
      const functionToCall = functions[functionName];
      if (functionToCall) {
        const result = await functionToCall(functionArgs);
        toolOutputs.push({
          tool_call_id: toolCall.id,
          output: JSON.stringify(result)
        });
      } else {
        toolOutputs.push({
          tool_call_id: toolCall.id,
          output: JSON.stringify({ error: `Function ${functionName} não encontrada` })
        });
      }
    } catch (error) {
      logError(error, `Function ${functionName}`);
      toolOutputs.push({
        tool_call_id: toolCall.id,
        output: JSON.stringify({ error: error.message })
      });
    }
  }

  // Submeter resultados de volta para o Assistant
  await client.beta.threads.runs.submitToolOutputs(threadId, runId, {
    tool_outputs: toolOutputs
  });
}

// Implementação das functions

async function addUserEmail({ telegram_id, email }) {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO users (telegram_id, email) 
      VALUES ($1, $2) 
      ON CONFLICT (telegram_id) 
      DO UPDATE SET email = $2
    `, [telegram_id, email]);
    
    return { success: true, message: 'Email cadastrado com sucesso!' };
  } finally {
    client.release();
  }
}

async function getDepartments() {
  // Lista fixa de departamentos - você pode mover para o banco depois
  return {
    departments: [
      { name: 'TI - Tecnologia da Informação', email: 'ti@kx3.com.br' },
      { name: 'RH - Recursos Humanos', email: 'rh@kx3.com.br' },
      { name: 'Financeiro', email: 'financeiro@kx3.com.br' },
      { name: 'Comercial', email: 'comercial@kx3.com.br' },
      { name: 'Suporte Técnico', email: 'suporte@kx3.com.br' }
    ]
  };
}

async function openTicket({ telegram_id, department, subject, description, attachments = [] }) {
  const client = await pool.connect();
  
  try {
    // Buscar usuário
    const userResult = await client.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
    if (userResult.rows.length === 0) {
      return { error: 'Usuário não encontrado. Faça seu cadastro primeiro.' };
    }
    
    const user = userResult.rows[0];
    
    // Gerar protocolo único
    const protocol = `CAR${Date.now().toString().slice(-6)}`;
    
    // Salvar ticket no banco
    const ticketResult = await client.query(`
      INSERT INTO tickets (protocol, user_id, department, subject, description, attachments, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'Aberto')
      RETURNING *
    `, [protocol, user.id, department, subject, description, JSON.stringify(attachments)]);
    
    const ticket = ticketResult.rows[0];
    
    // Adicionar à planilha
    await addTicketToSheet({
      protocol,
      user_name: 'Representante', // ou pegar nome real se tiver
      email: user.email,
      department,
      subject,
      description,
      status: 'Aberto',
      attachment_links: attachments.map(a => a.url).join(', ')
    });
    
    // Enviar email para o departamento
    const deptList = await getDepartments();
    const deptInfo = deptList.departments.find(d => d.name === department);
    
    if (deptInfo) {
      const emailHtml = `
        <h2>Novo Chamado - Protocolo: ${protocol}</h2>
        <p><strong>De:</strong> ${user.email}</p>
        <p><strong>Departamento:</strong> ${department}</p>
        <p><strong>Assunto:</strong> ${subject}</p>
        <p><strong>Descrição:</strong></p>
        <p>${description.replace(/\n/g, '<br>')}</p>
        ${attachments.length > 0 ? `
          <p><strong>Anexos:</strong></p>
          <ul>
            ${attachments.map(a => `<li><a href="${a.url}">${a.name}</a></li>`).join('')}
          </ul>
        ` : ''}
        <hr>
        <p><em>Para responder, reply este email. O usuário será notificado automaticamente.</em></p>
      `;
      
      await sendMail({
        to: deptInfo.email,
        subject: `[${protocol}] ${subject}`,
        html: emailHtml
      });
    }
    
    return {
      success: true,
      protocol,
      message: `Chamado criado com sucesso!\n\nProtocolo: ${protocol}\nDepartamento: ${department}\n\nVocê receberá atualizações por aqui quando houver resposta.`
    };
    
  } finally {
    client.release();
  }
}

async function listTickets({ telegram_id }) {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT t.protocol, t.subject, t.department, t.status, t.opened_at
      FROM tickets t
      JOIN users u ON t.user_id = u.id
      WHERE u.telegram_id = $1 AND t.status != 'Finalizado'
      ORDER BY t.opened_at DESC
    `, [telegram_id]);
    
    return { tickets: result.rows };
  } finally {
    client.release();
  }
}

async function getTicketDetail({ protocol }) {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM tickets WHERE protocol = $1', [protocol]);
    
    if (result.rows.length === 0) {
      return { error: 'Chamado não encontrado' };
    }
    
    return { ticket: result.rows[0] };
  } finally {
    client.release();
  }
}

async function closeTicket({ protocol }) {
  const client = await pool.connect();
  try {
    await client.query(`
      UPDATE tickets 
      SET status = 'Finalizado', closed_at = NOW() 
      WHERE protocol = $1
    `, [protocol]);
    
    await updateTicketStatusInSheet(protocol, 'Finalizado');
    
    return { success: true, message: 'Chamado finalizado com sucesso!' };
  } finally {
    client.release();
  }
}

async function replyTicket({ protocol, body, attachments = [] }) {
  // Esta função será chamada quando o usuário quiser complementar um chamado
  // Por enquanto só retorna sucesso - a lógica de email pode ser adicionada depois
  return { 
    success: true, 
    message: 'Complemento adicionado ao chamado. O departamento será notificado.' 
  };
}

async function transcribeAudio({ file_id }) {
  // Placeholder para transcrição de áudio
  // Você pode implementar usando a API de transcrição da OpenAI depois
  return { 
    transcription: '[Transcrição de áudio não implementada ainda]' 
  };
}
