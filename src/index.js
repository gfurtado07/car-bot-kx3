import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { functionsRouter } from './functions.js';
import { uploadAttachments } from './storage.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

bot.start((ctx) => ctx.reply('Olá! Sou o CAR da KX3. Como posso ajudar?'));

bot.on('message', async (ctx) => {
  if (ctx.message.text === '/start') return;

  try {
    console.log(`📩 Nova mensagem de ${ctx.from.first_name}`);

    // 1. Upload anexos (se houver)
    let attachments = [];
    if (ctx.message.document || ctx.message.photo) {
      attachments = await uploadAttachments(ctx);
    }
    
    // 2. Preparar dados para o Agent
    const messageData = {
      text: ctx.message.text || 'Arquivo enviado',
      telegram_id: ctx.from.id.toString(),
      telegram_name: `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim(),
      voice_file_id: ctx.message.voice?.file_id || null,
      attachments: attachments
    };

    console.log(`🤖 Enviando para Agent:`, messageData);

    // 3. Criar thread e enviar ao Agent
    const thread = await openai.beta.threads.create();
    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: JSON.stringify(messageData)
    });

    // 4. Executar com Agent
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID
    });

    // 5. Loop até completar
    let completed = false;
    while (!completed) {
      const status = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      
      if (status.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(thread.id);
        const response = messages.data[0]?.content[0]?.text?.value;
        if (response) {
          console.log(`💬 Resposta do Agent: ${response.substring(0, 100)}...`);
          await ctx.reply(response);
        }
        completed = true;
      }
      
      if (status.status === 'requires_action') {
        console.log(`⚙️ Executando function call...`);
        await functionsRouter(thread.id, run.id, status.required_action);
      }
      
      if (status.status === 'failed') {
        console.error(`❌ Run falhou:`, status.last_error);
        await ctx.reply('⚠️ Erro no processamento. Tente novamente.');
        completed = true;
      }
      
      await new Promise(r => setTimeout(r, 500));
    }

  } catch (error) {
    console.error('❌ Erro geral:', error);
    await ctx.reply('⚠️ Erro temporário. Tente novamente.');
  }
});

// Iniciar bot
async function startBot() {
  try {
    console.log('🚀 Iniciando CAR Bot...');
    await bot.launch({ polling: true });
    console.log('✅ CAR Bot ativo!');
  } catch (error) {
    console.error('❌ Erro ao iniciar bot:', error);
    process.exit(1);
  }
}

startBot();

// Para webhook (se precisar depois)
export const handler = bot.webhookCallback('/telegram');




