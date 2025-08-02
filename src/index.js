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

REGRAS CRÍTICAS DE INTERAÇÃO:
1. NO PRIMEIRO CONTATO (/start):
   - SEMPRE pergunte o nome completo
   - NÃO prossiga sem ter o nome confirmado
   - Use addUserName APENAS após confirmação explícita
   - Se não confirmar, continue pedindo

2. Após confirmação do nome:
   - Cumprimentar pelo nome correto
   - Coletar e-mail na sequência (chame addUserEmail)

3. TAREFAS PRINCIPAIS:
   - Abrir novo chamado
   - Consultar chamados em aberto  
   - Pesquisar chamado específico
   - Alterar meu e-mail

EXEMPLOS DE FLUXO:
- Usuário: /start
- Bot: "Olá! Para começarmos, qual é seu nome completo?"
- Usuário: "Guilherme Furtado"
- Bot: "Posso confirmar: seu nome é Guilherme Furtado? (Sim/Não)"
- Se Sim: Registra com addUserName
- Se Não: "Por favor, me diga novamente seu nome completo"

COMPORTAMENTO:
- Seja cordial, profissional e eficiente
- Sempre confirme dados antes de criar chamados
- Use emojis moderadamente
- Mantenha conversas focadas no atendimento

ESTADO INICIAL:
- Nome do usuário: NÃO COLETADO
- Próxima ação: COLETAR NOME

FUNCTIONS DISPONÍVEIS:
- addUserName(telegram_id, full_name)
- addUserEmail(telegram_id, email)
- getDepartments()
- openTicket(...)
- listTickets(...)
- getTicketDetail(...)
- closeTicket(...)
`
        }
      ],
      userInfo: {
        nameCollected: false,
        confirmingName: false,
        pendingName: null
      }
    });
  }
  return userContexts.get(userId);
}

// Comando de início
bot.start(async (ctx) => {
  try {
    const context = getUserContext(ctx.from.id);
    context.messages = context.messages.slice(0, 1); // Reset conversa, manter só system
    context.userInfo.nameCollected = false;
    context.userInfo.confirmingName = false;
    context.userInfo.pendingName = null;

    await ctx.reply('Olá! Para começarmos, qual é seu nome completo?');
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

    // Se nome não foi coletado, forçar coleta de nome
    if (!context.userInfo.nameCollected) {
      let messageContent = ctx.message.text || 'Arquivo enviado';

      if (!context.userInfo.confirmingName) {
        // Primeira vez perguntando o nome
        context.userInfo.confirmingName = true;
        context.userInfo.pendingName = messageContent;

        await ctx.reply(`Posso confirmar: seu nome é ${messageContent}? (Sim/Não)`);
        return;
      } else {
        // Verificando confirmação de nome
        if (messageContent.toLowerCase().includes('sim')) {
          // Nome confirmado
          const extractedName = context.userInfo.pendingName;
          
          // Chamar função para salvar nome
          await functionsRouter(null, null, {
            submit_tool_outputs: {
              tool_calls: [{
                id: 'name_confirmation',
                function: {
                  name: 'addUserName',
                  arguments: JSON.stringify({
                    telegram_id: ctx.from.id.toString(),
                    full_name: extractedName
                  })
                }
              }]
            }
          });

          context.userInfo.nameCollected = true;
          context.userInfo.confirmingName = false;
          context.userInfo.pendingName = null;

          await ctx.reply(`Ótimo, ${extractedName}! Agora, por favor, me informe seu e-mail.`);
          return;
        } else {
          // Nome não confirmado
          context.userInfo.confirmingName = false;
          context.userInfo.pendingName = null;
          await ctx.reply('Por favor, me diga novamente seu nome completo.');
          return;
        }
      }
    }

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
      
      // Por enquanto, apenas lograr e responder
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

// Para Background Worker - sempre usar polling
async function startBotProduction() {
  try {
    console.log('🚀 Iniciando bot em modo Background Worker...');
    console.log('📡 Usando polling (não webhook)');
    
    await bot.launch({
      polling: {
        timeout: 10,
        limit: 100,
        retryAfter: 1,
        allowedUpdates: ['message', 'callback_query']
      }
    });
    
    console.log('✅ Bot iniciado com sucesso em produção!');
    console.log('🤖 Modo: Polling ativo');
    
  } catch (error) {
    console.error('❌ Erro ao iniciar bot:', error);
    process.exit(1);
  }
}

// Iniciar baseado no ambiente
if (process.env.NODE_ENV === 'production') {
  startBotProduction();
} else {
  startBot(); // Função de desenvolvimento
}

// Export para compatibilidade (não usado em Background Worker)
export const handler = bot.webhookCallback('/telegram');
