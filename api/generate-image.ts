import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleAuth } from 'google-auth-library';

export const config = {
  maxDuration: 120,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS Headers
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
    const { image, prompt, modelKey, aspectRatio } = req.body;

    if (!image || !prompt) {
      return res.status(400).json({ error: 'Missing image or prompt' });
    }

    // --- MAPPING MODEL ID (IMAGE MODELS) ---
    // ENV overrides:
    // - VERTEX_LOCATION (default: us-central1)
    // - GEMINI_IMAGE_MODEL_FAST (default: gemini-2.5-flash-image)
    // - GEMINI_IMAGE_MODEL_QUALITY (default: gemini-3-pro-image-preview)
    const fastDefault = process.env.GEMINI_IMAGE_MODEL_FAST || 'gemini-2.5-flash-image';
    const qualityDefault = process.env.GEMINI_IMAGE_MODEL_QUALITY || 'gemini-3-pro-image-preview';

    // Default fallback
    let vertexModelId = fastDefault;

    // ModelKey dari frontend diharapkan:
    // - 'gemini-2.5-flash-image'
    // - 'gemini-3-pro-image-preview'
    if (modelKey === 'gemini-3-pro-image-preview') {
      vertexModelId = qualityDefault;
    } else if (modelKey === 'gemini-2.5-flash-image') {
      vertexModelId = fastDefault;
    } else if (typeof modelKey === 'string' && modelKey.trim()) {
      // kalau frontend kirim langsung model id lain yang valid
      vertexModelId = modelKey.trim();
    }

    // --- SETUP AUTH ---
    const projectId = process.env.GCP_PROJECT_ID;
    const clientEmail = process.env.GCP_CLIENT_EMAIL;
    const privateKey = process.env.GCP_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      console.error('Missing GCP Credentials');
      return res.status(500).json({ error: 'Server Auth Config Error' });
    }

    const auth = new GoogleAuth({
      credentials: { client_email: clientEmail, private_key: privateKey, project_id: projectId },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    const client = await auth.getClient();
    const accessTokenResp = await client.getAccessToken();
    const accessToken = typeof accessTokenResp === 'string' ? accessTokenResp : accessTokenResp?.token;

    if (!accessToken) {
      console.error('Failed to obtain access token');
      return res.status(500).json({ error: 'Failed to obtain access token' });
    }

    // --- CALL VERTEX AI (GEMINI) ---
    const location = process.env.VERTEX_LOCATION || 'us-central1';

    // IMPORTANT FIX:
    // Preview models => use v1beta1 + GLOBAL host
    const isPreview = /preview/i.test(vertexModelId);
    const apiVersion = isPreview ? 'v1beta1' : 'v1';
    const host = isPreview ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;

    const endpoint = `https://${host}/${apiVersion}/projects/${projectId}/locations/${location}/publishers/google/models/${vertexModelId}:generateContent`;

    const base64Image = image.includes(',') ? image.split(',')[1] : image;
    const inputMimeType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

    // Vertex Gemini Payload
    const payload: any = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: inputMimeType, data: base64Image } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
        // IMPORTANT: request image output
        responseMimeType: 'image/png',
      },
    };

    // (optional) kalau kamu mau pakai aspectRatio di prompt, bisa tambahkan di prompt, bukan di config.
    // aspectRatio tidak selalu supported sebagai field config untuk semua model.

    const apiRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // SAFER parsing: avoid "Unexpected token <"
    const raw = await apiRes.text();
    let data: any = null;
    try {
      data = JSON.parse(raw);
    } catch {
      // non-JSON response (HTML, etc.)
      console.error('Non-JSON response from Vertex', {
        status: apiRes.status,
        endpoint,
        raw: raw.slice(0, 400),
      });
      throw new Error(`Non-JSON response from Vertex (${apiRes.status}). Check endpoint/model/permissions.`);
    }

    if (!apiRes.ok) {
      console.error('Vertex API Error:', {
        status: apiRes.status,
        endpoint,
        model: vertexModelId,
        error: data?.err
