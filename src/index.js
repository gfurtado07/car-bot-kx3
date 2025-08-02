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
    log('Nova mensagem recebida', {
      user: ctx.from.id,
      message: ctx.message.text || '[arquivo/mídia]'
    });

    // Upload de anexos
    let attachmentLinks = [];
    if (ctx.message.document || ctx.message.photo) {
      attachmentLinks = await uploadAttachments(ctx);
    }

    // Nome sugerido do Telegram
    const telegramName = `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim();

    // Montar conteúdo principal
    let messageContent = ctx.message.text || 'Arquivo enviado';
    if (attachmentLinks.length > 0) {
      messageContent += `\n\n[Anexos: ${attachmentLinks.map(a => a.name).join(', ')}]`;
    }
    if (ctx.message.voice) {
      messageContent += `\n\n[Áudio enviado - file_id: ${ctx.message.voice.file_id}]`;
    }

    // Criar thread
    const thread = await openai.beta.threads.create();

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: messageContent,
      metadata: {
        telegram_id: ctx.from.id.toString(),
        telegram_name: telegramName,
        file_id: ctx.message.voice?.file_id || null
      },
      attachments: attachmentLinks || []
    });

    // 🛡️ Protege a chamada ao Assistant com try/catch
    let run;
    try {
      run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: process.env.OPENAI_ASSISTANT_ID,
        tools: [{ type: 'function' }],
        model: 'gpt-4o-mini'
      });
    } catch (error) {
      console.error('❌ Erro ao iniciar run com OpenAI:', error);
      await ctx.reply('⚠️ Erro ao processar com a inteligência do bot. Tente novamente em alguns instantes.');
      return;
    }

    let completed = false;
    let lastResponse = null;

    while (!completed) {
      const result = await openai.beta.threads.runs.retrieve(thread.id, run.id);

      if (result.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(thread.id);
        lastResponse = messages.data?.[0] || null;
        completed = true;
      }

      if (result.status === 'requires_action') {
        await functionsRouter(thread.id, run.id, result.required_action);
      }

      await new Promise((res) => setTimeout(res, 600));
    }

    if (lastResponse) {
      const replyText = lastResponse.content?.[0]?.text?.value || '[Sem resposta útil]';
      await ctx.reply(replyText);
    }

  } catch (error) {
    console.error('❌ Erro geral:', error);

    if (error.status === 500) {
      await ctx.reply('⚠️ O servidor está temporariamente indisponível. Tente novamente em alguns minutos.');
    } else if (error.status === 429) {
      await ctx.reply('⚠️ Muitas requisições em pouco tempo. Aguarde alguns segundos.');
    } else {
      await ctx.reply('❌ Desculpe, ocorreu um erro inesperado. Tente novamente.');
    }
  }
});

// Sempre usar polling para evitar conflitos (409 error)
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

// Force somente polling, sem webhook
startBot();

// Export (apenas se usar webhook em outros ambientes)
export const handler = bot.webhookCallback('/telegram');
