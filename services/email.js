const { ClientSecretCredential } = require('@azure/identity');
const { Client } = require('@microsoft/microsoft-graph-client');
const { TokenCredentialAuthenticationProvider } = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');

const getGraphClient = () => {
  const credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID,
    process.env.AZURE_CLIENT_ID,
    process.env.AZURE_CLIENT_SECRET
  );

  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default']
  });

  return Client.initWithMiddleware({ authProvider });
};

const getEmails = async () => {
  const client = getGraphClient();
  const messages = await client
    .api('/users/staff@arkfinancialservices.com/messages')
    .select('subject,from,receivedDateTime,bodyPreview')
    .top(25)
    .get();
  return messages.value;
};

const sendEmail = async ({ to, subject, body }) => {
  const client = getGraphClient();
  await client
    .api('/users/staff@arkfinancialservices.com/sendMail')
    .post({
      message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: to } }]
      }
    });
};

module.exports = { getEmails, sendEmail };
