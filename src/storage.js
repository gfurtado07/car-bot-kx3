import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function uploadAttachments(ctx) {
  const attachmentLinks = [];
  
  try {
    if (ctx.message.document) {
      const file = await ctx.telegram.getFile(ctx.message.document.file_id);
      const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
      
      // Por enquanto só retornamos o link do Telegram
      // Em produção, você pode fazer upload para S3 ou similar
      attachmentLinks.push({
        name: ctx.message.document.file_name,
        url: url
      });
    }

    if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const file = await ctx.telegram.getFile(photo.file_id);
      const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
      
      attachmentLinks.push({
        name: `photo_${photo.file_id}.jpg`,
        url: url
      });
    }

    return attachmentLinks;
  } catch (error) {
    console.error('Erro ao processar anexos:', error);
    return [];
  }
}
