-- Extensão para UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Tabela de usuários
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabela de tickets
CREATE TABLE tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  protocol VARCHAR(20) UNIQUE NOT NULL,
  user_id UUID REFERENCES users(id),
  department TEXT,
  subject TEXT,
  description TEXT,
  attachments JSONB,
  status VARCHAR(20) DEFAULT 'Aberto',
  opened_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  reopened_at TIMESTAMP
);

-- Índices para performance
CREATE INDEX idx_tickets_protocol ON tickets(protocol);
CREATE INDEX idx_tickets_user_id ON tickets(user_id);
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_users_telegram_id ON users(telegram_id);
