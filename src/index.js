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

    // 3. Criar thread
    const thread = await openai.beta.threads.create();
    console.log(`🧵 Thread criada: ${thread.id}`);

    // 4. Enviar mensagem ao thread
    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: JSON.stringify(messageData)
    });

    // 5. Criar run (com verificação de erro)
    let run;
    try {
      run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: process.env.OPENAI_ASSISTANT_ID
      });
      
      if (!run || !run.id) {
        throw new Error('Run criado mas sem ID válido');
      }
      
      console.log(`⚙️ Run criado: ${run.id}`);
    } catch (runError) {
      console.error('❌ Erro ao criar run:', runError);
      await ctx.reply('⚠️ Erro ao ativar assistente. Verifique se o OPENAI_ASSISTANT_ID está correto.');
      return;
    }

    // 6. Loop até completar
    let completed = false;
    let attempts = 0;
    const maxAttempts = 30; // 15 segundos máximo

    while (!completed && attempts < maxAttempts) {
      attempts++;
      
      try {
        const status = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        console.log(`🔄 Status do run (tentativa ${attempts}): ${status.status}`);
        
        if (status.status === 'completed') {
          const messages = await openai.beta.threads.messages.list(thread.id);
          const response = messages.data[0]?.content[0]?.text?.value;
          if (response) {
            console.log(`💬 Resposta do Agent: ${response.substring(0, 100)}...`);
            await ctx.reply(response);
          } else {
            await ctx.reply('⚠️ Assistente não retornou resposta. Tente novamente.');
          }
          completed = true;
        }
        
        else if (status.status === 'requires_action') {
          console.log(`⚙️ Executando function calls...`);
          await functionsRouter(thread.id, run.id, status.required_action);
        }
        
        else if (status.status === 'failed') {
          console.error(`❌ Run falhou:`, status.last_error);
          await ctx.reply('⚠️ Erro no processamento. Tente novamente.');
          completed = true;
        }
        
        else if (status.status === 'expired') {
          console.error(`⏰ Run expirou após ${attempts} tentativas`);
          await ctx.reply('⚠️ Processamento demorou demais. Tente novamente.');
          completed = true;
        }
        
      } catch (statusError) {
        console.error(`❌ Erro ao verificar status (tentativa ${attempts}):`, statusError);
        if (attempts >= maxAttempts) {
          await ctx.reply('⚠️ Erro persistente. Tente novamente em alguns minutos.');
          completed = true;
        }
      }
      
      if (!completed) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (attempts >= maxAttempts && !completed) {
      console.error(`⏰ Timeout após ${maxAttempts} tentativas`);
      await ctx.reply('⚠️ Processamento demorou demais. Tente novamente.');
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
    
    // Verificar se as variáveis essenciais existem
    if (!process.env.TELEGRAM_TOKEN) {
      throw new Error('TELEGRAM_TOKEN não configurado');
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY não configurado');
    }
    if (!process.env.OPENAI_ASSISTANT_ID) {
      throw new Error('OPENAI_ASSISTANT_ID não configurado');
    }
    
    console.log('✅ Variáveis de ambiente verificadas');
    
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





