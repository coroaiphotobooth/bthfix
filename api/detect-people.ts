import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleAuth } from 'google-auth-library';

export const config = {
  maxDuration: 60,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Missing image' });

    // AUTH
    const projectId = process.env.GCP_PROJECT_ID;
    const clientEmail = process.env.GCP_CLIENT_EMAIL;
    const privateKey = process.env.GCP_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      return res.status(500).json({ error: 'Auth Config Error' });
    }

    const auth = new GoogleAuth({
      credentials: { client_email: clientEmail, private_key: privateKey, project_id: projectId },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    const client = await auth.getClient();
    const accessTokenResp = await client.getAccessToken();
    const accessToken = typeof accessTokenResp === 'string' ? accessTokenResp : accessTokenResp?.token;

    if (!accessToken) {
      return res.status(500).json({ error: 'Failed to obtain access token' });
    }

    // Model untuk hitung orang: gunakan yang stabil & murah
    const location = process.env.VERTEX_LOCATION || 'us-central1';
    const modelId = process.env.GEMINI_COUNT_MODEL_ID || 'gemini-2.5-flash';

    // Kalau suatu saat model count kamu pakai "preview", otomatis pindah ke v1beta1 + host global
    const isPreview = /preview/i.test(modelId);
    const apiVersion = isPreview ? 'v1beta1' : 'v1';
    const host = isPreview ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;

    const endpoint = `https://${host}/${apiVersion}/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:generateContent`;

    const base64Image = image.includes(',') ? image.split(',')[1] : image;
    const mimeType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

    const payload = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                "Count how many humans are visible in this image. " +
                "Return strictly just the integer number (0,1,2,3...). " +
                "If unsure, return 1.",
            },
            { inlineData: { mimeType, data: base64Image } },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 10,
        temperature: 0,
      },
    };

    const apiRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // Aman: jangan langsung apiRes.json()
    const raw = await apiRes.text();
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error('Detect: Non-JSON response from Vertex', {
        status: apiRes.status,
        endpoint,
        raw: raw.slice(0, 300),
      });
      // fail-safe
      return res.status(200).json({ count: 1 });
    }

    if (!apiRes.ok) {
      console.error('Detect: Vertex error', {
        status: apiRes.status,
        endpoint,
        error: data?.error,
      });
      // fail-safe
      return res.status(200).json({ count: 1 });
    }

    const text =
      (data?.candidates?.[0]?.content?.parts || [])
        .map((p: any) => p.text || '')
        .join('')
        .trim() || '1';

    const n = parseInt(text.replace(/[^\d]/g, ''), 10);
    const count = Number.isFinite(n) ? n : 1;

    return res.status(200).json({ count });
  } catch (error: any) {
    console.error('Detect API Error:', error);
    return res.status(200).json({ count: 1 }); // Fail safe default
  }
}
