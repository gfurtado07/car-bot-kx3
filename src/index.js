import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { functionsRouter } from './functions.js';
import { uploadAttachments } from './storage.js';
import { log } from './utils/logger.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Comando /start
bot.start(async (ctx) => {
  await ctx.reply('Olá! Sou o CAR, seu assistente de atendimento da KX3. Como posso ajudá-lo hoje?');
});

// Handler principal
bot.on('message', async (ctx) => {
  if (ctx.message.text === '/start') return;

  try {
    log('📩 Nova mensagem recebida', {
      user: ctx.from.id,
      message: ctx.message.text || '[arquivo/mídia]'
    });

    // Upload de anexos (se houver)
    let attachmentLinks = [];
    if (ctx.message.document || ctx.message.photo) {
      attachmentLinks = await uploadAttachments(ctx);
    }

    const telegramName = `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim();
    const messageContent = ctx.message.text || 'Arquivo enviado';

    // Criar thread OpenAI
    let thread;
    try {
      thread = await openai.beta.threads.create();
    } catch (err) {
      console.error('❌ Erro ao criar thread OpenAI:', err);
      await ctx.reply('⚠️ Erro ao iniciar atendimento. Tente novamente.');
      return;
    }

    // Criar estrutura da mensagem convencional
    const payload = {
      role: 'user',
      content: messageContent
    };

    const metadata = {
      telegram_id: ctx.from.id?.toString(),
      telegram_name: telegramName
    };
    if (ctx.message.voice?.file_id) {
      metadata.file_id = ctx.message.voice.file_id;
    }
    payload.metadata = metadata;

    if (attachmentLinks.length > 0) {
      payload.attachments = attachmentLinks;
    }

    try {
      await openai.beta.threads.messages.create(thread.id, payload);
    } catch (err) {
      console.error('❌ Erro ao enviar mensagem ao Assistant:', err);
      await ctx.reply('⚠️ Não consegui enviar sua mensagem. Tente novamente.');
      return;
    }

    // Executar Assistente
    let run;
    try {
      run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: process.env.OPENAI_ASSISTANT_ID
        // Não defina tools aqui, pois já estão registradas no painel do Assistant
      });
    } catch (err) {
      console.error('❌ Erro ao iniciar execução (run):', {
        message: err.message,
        status: err.status,
        body: err.response?.data || '[sem corpo de resposta]'
      });
      await ctx.reply('⚠️ Não consegui ativar minha inteligência. Tente novamente em instantes.');
      return;
    }

    // Loop de progresso
    let completed = false;
    let lastResponse = null;

    while (!completed) {
      const status = await openai.beta.threads.runs.retrieve(thread.id, run.id);

      if (status.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(thread.id);
        lastResponse = messages.data?.[0] || null;
        completed = true;
      }

      if (status.status === 'requires_action') {
        try {
          console.log(`⚙️ Executando função solicitada: ${status.required_action?.function_call?.name}`);
          await functionsRouter(thread.id, run.id, status.required_action);
        } catch (err) {
          console.error('❌ Erro ao executar função do Assistant:', err);
          await ctx.reply('❌ Houve um erro ao completar sua solicitação. Tente novamente.');
          return;
        }
      }

      await new Promise((res) => setTimeout(res, 600));
    }

    if (lastResponse) {
      const replyText = lastResponse.content?.[0]?.text?.value || '[Resposta vazia do assistente]';
      await ctx.reply(replyText);
    }

  } catch (error) {
    console.error('❌ Erro geral no processamento:', error);

    if (error.status === 500) {
      await ctx.reply('⚠️ O servidor está indisponível. Tente novamente daqui a alguns minutos.');
    } else if (error.status === 429) {
      await ctx.reply('⚠️ Muitas requisições em sequência. Aguarde um pouco.');
    } else {
      await ctx.reply('❌ Erro inesperado. Tente novamente mais tarde.');
    }
  }
});

// Opções de polling
const launchOptions = {
  polling: {
    timeout: 10,
    limit: 100,
    retryAfter: 1
  }
};

async function startBot() {
  try {
    console.log('🚀 Iniciando CAR BOT (modo polling)...');
    await bot.launch(launchOptions);
    console.log('✅ Bot iniciado com sucesso via polling!');
  } catch (err) {
    console.error('Erro ao iniciar o bot:', err);
    process.exit(1);
  }
}

startBot();

// Export opcional se for usar webhook
export const handler = bot.webhookCallback('/telegram');


