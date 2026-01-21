import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleAuth } from 'google-auth-library';

export const config = {
  maxDuration: 300, 
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { image, prompt, aspectRatio } = req.body;

    if (!image || !prompt) {
      return res.status(400).json({ error: 'Missing image or prompt' });
    }

    const projectId = process.env.GCP_PROJECT_ID;
    const clientEmail = process.env.GCP_CLIENT_EMAIL;
    const privateKey = process.env.GCP_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      console.error("Missing GCP Credentials in Environment Variables");
      return res.status(500).json({ error: 'Server configuration error: Missing GCP Credentials.' });
    }

    const auth = new GoogleAuth({
      credentials: {
        client_email: clientEmail,
        private_key: privateKey,
        project_id: projectId,
      },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    // MODEL VEO 3.1 FAST
    // You can override via Vercel env vars if needed.
    const location = process.env.VERTEX_LOCATION || 'us-central1';
    const modelId = process.env.VEO_MODEL_ID || 'veo-3.1-fast-generate-001'; 
    const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:predict`;

    const base64Image = image.includes(',') ? image.split(',')[1] : image;

    const payload = {
      instances: [
        {
          prompt: prompt,
          image: {
             bytesBase64Encoded: base64Image
          }
        }
      ],
      parameters: {
        aspectRatio: aspectRatio || "9:16",
        sampleCount: 1,
        // negativePrompt: "", 
      }
    };

    console.log(`Calling Vertex AI Veo Endpoint: ${modelId}`);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Vertex AI Error Response:", JSON.stringify(data));
      throw new Error(data.error?.message || `Vertex AI API Failed with status ${response.status}`);
    }

    let videoBase64 = null;
    if (data.predictions && data.predictions.length > 0) {
      const prediction = data.predictions[0];
      if (typeof prediction === 'string') {
          videoBase64 = prediction;
      } else if (prediction.bytesBase64Encoded) {
          videoBase64 = prediction.bytesBase64Encoded;
      } else if (prediction.video?.bytesBase64Encoded) {
          videoBase64 = prediction.video.bytesBase64Encoded;
      }
    }

    if (!videoBase64) {
      console.error("Unexpected Vertex AI response format:", JSON.stringify(data));
      return res.status(500).json({ error: 'No video data received from Vertex AI.' });
    }

    return res.status(200).json({ video: `data:video/mp4;base64,${videoBase64}` });

  } catch (error: any) {
    console.error("API Handler Error:", error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}