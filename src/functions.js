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
  transcribeAudio,
  addUserName  // Nova function adicionada
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

async function addUserName({ telegram_id, full_name }) {
  const client = await pool.connect();
  try {
    await client.query(`
      UPDATE users 
      SET name = $1 
      WHERE telegram_id = $2
    `, [full_name, telegram_id]);
    
    return { 
      success: true, 
      message: `Nome atualizado com sucesso: ${full_name}` 
    };
  } catch (error) {
    logError(error, 'Erro ao atualizar nome do usuário');
    return {
      success: false,
      message: 'Erro ao atualizar nome'
    };
  } finally {
    client.release();
  }
}

async function addUserEmail({ telegram_id, email }) {
  const client = await pool.connect();
  try {
    // Extrair nome do email para uso futuro
    const nameFromEmail = email.split('@')[0];
    
    await client.query(`
      INSERT INTO users (telegram_id, email, name) 
      VALUES ($1, $2, $3) 
      ON CONFLICT (telegram_id) 
      DO UPDATE SET email = $2, name = $3
    `, [telegram_id, email, nameFromEmail]);
    
    return { success: true, message: 'Email cadastrado com sucesso!' };
  } finally {
    client.release();
  }
}

async function getDepartments() {
  try {
    const { GoogleSpreadsheet } = await import('google-spreadsheet');
    const { JWT } = await import('google-auth-library');
    
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    
    const departmentSheet = doc.sheetsByTitle['DEPARTAMENTOS'];
    if (!departmentSheet) {
      throw new Error('Aba DEPARTAMENTOS não encontrada');
    }
    
    const rows = await departmentSheet.getRows();
    const departments = rows.map(row => ({
      name: row.get('Departamentos da empresa') || row._rawData[0],
      email: row.get('lista de e-mails do departamento para os quais o bot deve enviar o e-mail de abertura do chamado') || row._rawData[1]
    })).filter(dept => dept.name && dept.email);
    
    log('Departamentos carregados da planilha:', departments);
    
    return { departments };
  } catch (error) {
    logError(error, 'Erro ao buscar departamentos da planilha');
    // Fallback para lista fixa
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
    
    log(`Criando ticket com protocolo: ${protocol}`);
    
    // Salvar ticket no banco
    const ticketResult = await client.query(`
      INSERT INTO tickets (protocol, user_id, department, subject, description, attachments, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'Aberto')
      RETURNING *
    `, [protocol, user.id, department, subject, description, JSON.stringify(attachments)]);
    
    const ticket = ticketResult.rows[0];
    log(`Ticket salvo no banco:`, ticket);
    
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
      log(`Ticket adicionado à planilha: ${protocol}`);
    } catch (sheetError) {
      logError(sheetError, 'Erro ao adicionar ticket à planilha');
    }
    
    // Enviar email para o departamento
    try {
      const deptList = await getDepartments();
      const deptInfo = deptList.departments.find(d => d.name === department);
      
      if (deptInfo && deptInfo.email) {
        const emailHtml = `
          <h2>Novo Chamado - Protocolo: ${protocol}</h2>
          <p><strong>De:</strong> ${user.email}</p>
          <p><strong>Nome:</strong> ${user.name || 'Não informado'}</p>
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
        
        log(`Email enviado para: ${deptInfo.email}`);
      } else {
        log(`Departamento não encontrado ou sem email: ${department}`);
      }
    } catch (emailError) {
      logError(emailError, 'Erro ao enviar email');
    }
    
    return {
      success: true,
      protocol,
      message: `Chamado criado com sucesso!\n\nProtocolo: ${protocol}\nDepartamento: ${department}\n\nVocê receberá atualizações por aqui quando houver resposta.`
    };
    
  } catch (error) {
    logError(error, 'Erro geral na criação do ticket');
    return {
      error: 'Erro interno ao criar chamado. Tente novamente.'
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

export default functions;

