import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import { functionsRouter } from './functions.js';
import { uploadAttachments } from './storage.js';
import { log } from './utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Sistema de contexto por usuário (em memória por enquanto)
const userContexts = new Map();

function getUserContext(userId) {
  if (!userContexts.has(userId)) {
    userContexts.set(userId, {
      messages: [
        {
          role: 'system',
          content: `Você é o CAR, bot de atendimento aos representantes comerciais da KX3.

TAREFAS PRINCIPAIS:
1. Cumprimentar e coletar e-mail na primeira interação
2. Exibir menu principal:
   - Abrir novo chamado
   - Consultar chamados em aberto  
   - Pesquisar chamado específico
   - Alterar meu e-mail

3. Para novo chamado:
   - Mostrar lista de departamentos
   - Solicitar assunto e descrição
   - Perguntar sobre anexos
   - Gerar resumo e pedir confirmação

COMPORTAMENTO:
- Seja cordial, profissional e eficiente
- Use emojis moderadamente
- Mantenha conversas focadas no atendimento
- Sempre confirme dados antes de executar ações

FUNCTIONS DISPONÍVEIS:
Quando necessário, indique qual function deve ser chamada no formato:
[FUNCTION: nome_da_function(parametros)]

Functions disponíveis:
- addUserEmail(telegram_id, email)
- getDepartments()
- openTicket(telegram_id, department, subject, description, attachments)
- listTickets(telegram_id)
- getTicketDetail(protocol)
- closeTicket(protocol)

Por enquanto, simule as respostas dessas functions.`
        }
      ],
      userInfo: null
    });
  }
  return userContexts.get(userId);
}

// Comando de início
bot.start(async (ctx) => {
  try {
    const context = getUserContext(ctx.from.id);
    context.messages = context.messages.slice(0, 1); // Reset conversa, manter só system
    await ctx.reply('Olá! Sou o CAR, seu assistente de atendimento da KX3. Como posso ajudá-lo hoje?');
  } catch (error) {
    console.error('Erro no /start:', error);
  }
});

// Handler principal
bot.on('message', async (ctx) => {
  if (ctx.message.text === '/start') return;

  try {
    log('Nova mensagem recebida', {
      user: ctx.from.id,
      message: ctx.message.text || '[arquivo/mídia]'
    });

    const context = getUserContext(ctx.from.id);

    // Processar anexos
    let attachmentLinks = [];
    if (ctx.message.document || ctx.message.photo) {
      attachmentLinks = await uploadAttachments(ctx);
    }

    // Preparar conteúdo da mensagem
    let messageContent = ctx.message.text || 'Arquivo enviado';
    
    if (attachmentLinks.length > 0) {
      messageContent += `\n\n[Anexos: ${attachmentLinks.map(a => a.name).join(', ')}]`;
    }

    if (ctx.message.voice) {
      messageContent += `\n\n[Áudio enviado - file_id: ${ctx.message.voice.file_id}]`;
    }

    // Adicionar contexto do usuário
    messageContent += `\n\n[Telegram ID: ${ctx.from.id}]`;

    // Adicionar mensagem à conversa
    context.messages.push({
      role: 'user',
      content: messageContent
    });

    // Manter histórico limitado (últimas 10 mensagens + system)
    if (context.messages.length > 21) { // 1 system + 20 mensagens
      context.messages = [
        context.messages[0], // manter system message
        ...context.messages.slice(-20) // últimas 20
      ];
    }

    // Chamar OpenAI Chat Completion
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: context.messages,
      temperature: 0.7,
      max_tokens: 1000
    });

    const assistantMessage = response.choices[0].message.content;
    
    // Adicionar resposta ao contexto
    context.messages.push({
      role: 'assistant',
      content: assistantMessage
    });

    // Verificar se precisa executar alguma function
    const functionMatch = assistantMessage.match(/\[FUNCTION:\s*(\w+)\((.*?)\)\]/);
    if (functionMatch) {
      const [, functionName, params] = functionMatch;
      log(`Function solicitada: ${functionName}`, params);
      
      // Por enquanto, apenas loggar e responder
      await ctx.reply(`🤖 Entendi que preciso executar: ${functionName}\n\n${assistantMessage.replace(/\[FUNCTION:.*?\]/, '').trim()}`);
    } else {
      await ctx.reply(assistantMessage);
    }
    
  } catch (error) {
    console.error('Erro no bot:', error);
    
    if (error.status === 500) {
      await ctx.reply('O servidor está temporariamente indisponível. Tente novamente em alguns minutos.');
    } else if (error.status === 429) {
      await ctx.reply('Muitas requisições. Aguarde um momento e tente novamente.');
    } else {
      await ctx.reply('Desculpe, ocorreu um erro. Tente novamente.');
    }
  }
});

// Configurações de polling
const launchOptions = {
  polling: {
    timeout: 10,
    limit: 100,
    retryAfter: 1
  }
};

// Iniciar bot
async function startBot() {
  try {
    console.log('Iniciando bot com Chat Completions...');
    await bot.launch(launchOptions);
    console.log('✅ Bot iniciado com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao iniciar bot:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

if (process.env.NODE_ENV !== 'production') {
  startBot();
}

export const handler = bot.webhookCallback('/telegram');

