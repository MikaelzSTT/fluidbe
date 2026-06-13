const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

const CONNECTOR_REGISTRY = [
  {
    provider: 'stripe',
    label: 'Stripe',
    description: 'Conecta pagamentos, checkout e assinaturas usando a chave secreta da Stripe.',
    authType: 'api_key',
    fields: [
      {
        name: 'secret_key',
        label: 'Secret key',
        type: 'password',
        placeholder: 'sk_test_...',
        required: true,
      },
    ],
  },
  {
    provider: 'google_maps',
    label: 'Google Maps',
    description: 'Conecta mapas, rotas, geocoding e recursos de localização via Google Maps Platform.',
    authType: 'api_key',
    fields: [
      {
        name: 'api_key',
        label: 'API key',
        type: 'password',
        placeholder: 'AIza...',
        required: true,
      },
      {
        name: 'allowed_domains',
        label: 'Allowed domains',
        type: 'text',
        placeholder: 'example.com, app.example.com',
        required: false,
      },
    ],
  },
  {
    provider: 'resend',
    label: 'Resend',
    description: 'Conecta envio de emails transacionais e notificações usando Resend.',
    authType: 'api_key',
    fields: [
      {
        name: 'api_key',
        label: 'API key',
        type: 'password',
        placeholder: 're_...',
        required: true,
      },
      {
        name: 'from_email',
        label: 'From email',
        type: 'text',
        placeholder: 'noreply@example.com',
        required: true,
      },
    ],
  },
  {
    provider: 'supabase',
    label: 'Supabase',
    description: 'Conecta autenticação, banco de dados, storage e APIs do Supabase.',
    authType: 'credentials',
    fields: [
      {
        name: 'project_url',
        label: 'Project URL',
        type: 'text',
        placeholder: 'https://your-project.supabase.co',
        required: true,
      },
      {
        name: 'anon_key',
        label: 'Anon key',
        type: 'password',
        placeholder: 'eyJ...',
        required: true,
      },
      {
        name: 'service_role_key',
        label: 'Service role key',
        type: 'password',
        placeholder: 'eyJ...',
        required: false,
      },
    ],
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    description: 'Conecta recursos de IA, chat, assistentes e geração usando a API da OpenAI.',
    authType: 'api_key',
    fields: [
      {
        name: 'api_key',
        label: 'API key',
        type: 'password',
        placeholder: 'sk-...',
        required: true,
      },
    ],
  },
  {
    provider: 'cloudinary',
    label: 'Cloudinary',
    description: 'Conecta upload, transformação e gerenciamento de imagens e mídia.',
    authType: 'credentials',
    fields: [
      {
        name: 'cloud_name',
        label: 'Cloud name',
        type: 'text',
        placeholder: 'my-cloud',
        required: true,
      },
      {
        name: 'api_key',
        label: 'API key',
        type: 'text',
        placeholder: '123456789012345',
        required: true,
      },
      {
        name: 'api_secret',
        label: 'API secret',
        type: 'password',
        placeholder: '...',
        required: true,
      },
    ],
  },
  {
    provider: 'twilio',
    label: 'Twilio',
    description: 'Conecta SMS, WhatsApp, voz e notificações usando credenciais da Twilio.',
    authType: 'credentials',
    fields: [
      {
        name: 'account_sid',
        label: 'Account SID',
        type: 'text',
        placeholder: 'AC...',
        required: true,
      },
      {
        name: 'auth_token',
        label: 'Auth token',
        type: 'password',
        placeholder: '...',
        required: true,
      },
      {
        name: 'phone_number',
        label: 'Phone number',
        type: 'text',
        placeholder: '+15551234567',
        required: true,
      },
    ],
  },
  {
    provider: 'shopify',
    label: 'Shopify',
    description: 'Conecta lojas Shopify para produtos, pedidos e operações de ecommerce.',
    authType: 'credentials',
    fields: [
      {
        name: 'store_url',
        label: 'Store URL',
        type: 'text',
        placeholder: 'https://store.myshopify.com',
        required: true,
      },
      {
        name: 'access_token',
        label: 'Access token',
        type: 'password',
        placeholder: 'shpat_...',
        required: true,
      },
    ],
  },
  {
    provider: 'backend',
    label: 'Backend',
    description: 'Backend será configurado manualmente ou pela Fluid depois, conforme as necessidades do projeto.',
    authType: 'manual',
    fields: [],
  },
];

const CONNECTOR_BY_PROVIDER = new Map(
  CONNECTOR_REGISTRY.map((connector) => [connector.provider, connector])
);

router.get('/registry', authMiddleware, (req, res) => {
  return res.json(CONNECTOR_REGISTRY);
});

router.get('/registry/:provider', authMiddleware, (req, res) => {
  const provider = String(req.params.provider || '').trim().toLowerCase();
  const connector = CONNECTOR_BY_PROVIDER.get(provider);

  if (!connector) {
    return res.status(404).json({ message: 'Conector não encontrado.' });
  }

  return res.json(connector);
});

module.exports = router;
module.exports.CONNECTOR_REGISTRY = CONNECTOR_REGISTRY;
module.exports.CONNECTOR_BY_PROVIDER = CONNECTOR_BY_PROVIDER;
module.exports.getConnectorByProvider = function getConnectorByProvider(provider) {
  return CONNECTOR_BY_PROVIDER.get(String(provider || '').trim().toLowerCase());
};
