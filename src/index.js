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
      await ctx.reply('⚠️ Erro ao ativar assistente. Verifique configurações.');
      return;
    }

    // 6. Loop até completar - CORREÇÃO AQUI!
    let completed = false;
    let attempts = 0;
    const maxAttempts = 20; // Reduzido para 10 segundos

    while (!completed && attempts < maxAttempts) {
      attempts++;
      
      try {
        // ✅ CORREÇÃO: Parâmetros na ordem correta (threadId, runId)
        const status = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        console.log(`🔄 Status: ${status.status} (tentativa ${attempts})`);
        
        if (status.status === 'completed') {
          const messages = await openai.beta.threads.messages.list(thread.id);
          const response = messages.data[0]?.content[0]?.text?.value;
          if (response) {
            console.log(`💬 Resposta recebida (${response.length} chars)`);
            await ctx.reply(response);
          } else {
            await ctx.reply('⚠️ Assistente não retornou resposta.');
          }
          completed = true;
        }
        
        else if (status.status === 'requires_action') {
          console.log(`⚙️ Executando function calls...`);
          await functionsRouter(thread.id, run.id, status.required_action);
        }
        
        else if (status.status === 'failed') {
          console.error(`❌ Run falhou:`, status.last_error);
          await ctx.reply(`⚠️ Erro: ${status.last_error?.message || 'Falha no processamento'}`);
          completed = true;
        }
        
        else if (status.status === 'expired') {
          console.error(`⏰ Run expirou`);
          await ctx.reply('⚠️ Processamento expirou. Tente novamente.');
          completed = true;
        }
        
      } catch (statusError) {
        console.error(`❌ Erro ao verificar status:`, statusError.message);
        await ctx.reply('⚠️ Erro no processamento. Tente novamente.');
        completed = true;
        break;
      }
      
      if (!completed) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (attempts >= maxAttempts && !completed) {
      console.error(`⏰ Timeout após ${attempts} tentativas`);
      await ctx.reply('⚠️ Processamento demorou demais.');
    }

  } catch (error) {
    console.error('❌ Erro geral:', error.message);
    await ctx.reply('⚠️ Erro temporário. Tente novamente.');
  }
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Iniciar bot
async function startBot() {
  try {
    console.log('🚀 Iniciando CAR Bot...');
    
    // Verificar variáveis essenciais
    if (!process.env.TELEGRAM_TOKEN) {
      throw new Error('TELEGRAM_TOKEN não configurado');
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY não configurado');  
    }
    if (!process.env.OPENAI_ASSISTANT_ID) {
      throw new Error('OPENAI_ASSISTANT_ID não configurado');
    }
    
    console.log('✅ Variáveis verificadas');
    
    await bot.launch({ 
      polling: {
        timeout: 10,
        limit: 100
      }
    });
    
    console.log('✅ CAR Bot ATIVO!');
  } catch (error) {
    console.error('❌ Falha ao iniciar:', error.message);
    process.exit(1);
  }
}

startBot();

// Para webhook futuro
export const handler = bot.webhookCallback('/telegram');





