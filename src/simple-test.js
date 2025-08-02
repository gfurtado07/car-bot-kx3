import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function testSimpleChat() {
  try {
    console.log('Testando chat completion simples...');
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Você é o CAR, assistente de atendimento da KX3. Responda de forma cordial.'
        },
        {
          role: 'user',
          content: 'olá, tudo bem?'
        }
      ]
    });
    
    console.log('✅ Resposta:', response.choices[0].message.content);
    
  } catch (error) {
    console.error('❌ Erro:', error.message);
  }
}

testSimpleChat();
