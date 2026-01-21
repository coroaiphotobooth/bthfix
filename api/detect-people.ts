import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleAuth } from 'google-auth-library';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Missing image' });

    // AUTH
    const projectId = process.env.GCP_PROJECT_ID;
    const clientEmail = process.env.GCP_CLIENT_EMAIL;
    const privateKey = process.env.GCP_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) return res.status(500).json({ error: 'Auth Config Error' });

    const auth = new GoogleAuth({
      credentials: { client_email: clientEmail, private_key: privateKey, project_id: projectId },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    // Call Vertex AI Gemini Flash
    const location = process.env.VERTEX_LOCATION || 'us-central1';
    const modelId = process.env.GEMINI_COUNT_MODEL_ID || 'gemini-1.5-flash-002'; // Fast & Cheap
    const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:generateContent`;

    const base64Image = image.includes(',') ? image.split(',')[1] : image;

    const payload = {
      contents: [{
        role: "user",
        parts: [
          { text: "How many humans are visible in this image? Return strictly just the integer number. If unsure or 0, return 1." },
          { inlineData: { mimeType: 'image/jpeg', data: base64Image } }
        ]
      }],
      generationConfig: {
        maxOutputTokens: 10,
        temperature: 0
      }
    };

    const apiRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await apiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "1";
    const count = parseInt(text.trim()) || 1;

    return res.status(200).json({ count });

  } catch (error: any) {
    console.error("Detect API Error:", error);
    return res.status(200).json({ count: 1 }); // Fail safe default
  }
}