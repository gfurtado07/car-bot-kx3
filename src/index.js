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

    // Upload de anexos
    let attachmentLinks = [];
    if (ctx.message.document || ctx.message.photo) {
      attachmentLinks = await uploadAttachments(ctx);
    }

    const telegramName = `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim();
    let messageContent = ctx.message.text || 'Arquivo enviado';

    if (attachmentLinks.length > 0) {
      messageContent += `\n\n[Anexos: ${attachmentLinks.map(a => a.name).join(', ')}]`;
    }

    if (ctx.message.voice) {
      messageContent += `\n\n[Áudio enviado – file_id: ${ctx.message.voice.file_id}]`;
    }

    // Criar thread OpenAI
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

    // Iniciar execução com Assistant
    let run;
    try {
      run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: process.env.OPENAI_ASSISTANT_ID,
        tools: [{ type: 'function' }],
        model: 'gpt-4.1-mini'
      });
    } catch (err) {
      console.error('❌ Erro ao iniciar run com OpenAI:', {
        message: err.message,
        status: err.status,
        body: err.response?.data || '[sem corpo de resposta]'
      });
      await ctx.reply('⚠️ Erro ao conectar com a inteligência do bot. Verificamos o sistema e retornamos em instantes.');
      return;
    }

    // Verificador de andamento
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
          console.error('❌ Erro ao executar função chamada pelo Assistant:', err);
          await ctx.reply('❌ Houve um erro ao responder seu pedido. Por favor, tente novamente.');
          return;
        }
      }

      await new Promise((res) => setTimeout(res, 600));
    }

    // Enviar a resposta final para o usuário
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

// Opções para polling ao invés de webhook
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

// Exporta para uso com webhook, se necessário
export const handler = bot.webhookCallback('/telegram');


