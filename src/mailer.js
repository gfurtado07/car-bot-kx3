import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    type: 'OAuth2',
    user: process.env.GMAIL_SENDER,
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_REFRESH_TOKEN
  }
});

export async function sendMail({ to, subject, text, html, attachments = [] }) {
  try {
    const mailOptions = {
      from: process.env.GMAIL_SENDER,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      text,
      html,
      attachments
    };

    const result = await transporter.sendMail(mailOptions);
    console.log('Email enviado:', result.messageId);
    return result;
  } catch (error) {
    console.error('Erro ao enviar email:', error);
    throw error;
  }
}
