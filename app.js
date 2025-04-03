const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const session = require('express-session');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('./models/User');
const Project = require('./models/Project');
const multer = require('multer');
const vision = require('@google-cloud/vision');
const NodeCache = require('node-cache');
const sharp = require('sharp');
const axios = require('axios');
const cron = require('node-cron');

dotenv.config();

const app = express();

// Initialize cache with a TTL of 1 hour (3600 seconds)
const cache = new NodeCache({ stdTTL: 3600 });

// Multer setup for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Create uploads directory if it doesn't exist
const fs = require('fs');
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Connect to MongoDB Atlas
mongoose.connect(process.env.MONGODB_URI).then(() => {
    console.log('Connected to MongoDB Atlas');
}).catch((err) => {
    console.error('MongoDB Atlas connection error:', err);
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session setup
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
}));

// Initialize Google Cloud Vision client with explicit credentials
const vision = require('@google-cloud/vision');
const visionCredentials = JSON.parse(process.env.GOOGLE_CLOUD_VISION_CREDENTIALS);
const client = new vision.ImageAnnotatorClient({
    credentials: visionCredentials
});

// Gemini API configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent';

// Routes
app.post('/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }

        // Compress the image using sharp
        const compressedImagePath = path.join('uploads', `${Date.now()}.jpg`);
        await sharp(req.file.buffer)
            .resize({ width: 800 })
            .jpeg({ quality: 80 })
            .toFile(compressedImagePath);

        // Use Google Cloud Vision API to extract text, labels, and objects
        let textResult, labelResult, objectResult;
        try {
            [textResult] = await client.textDetection(compressedImagePath);
            [labelResult] = await client.labelDetection(compressedImagePath);
            [objectResult] = await client.objectLocalization(compressedImagePath);
        } catch (visionErr) {
            console.error('Vision API error:', visionErr);
            return res.status(500).json({ error: 'Failed to process image with Vision API' });
        }

        // Extract text
        let extractedText = '';
        const textDetections = textResult.textAnnotations;
        if (textDetections.length > 0) {
            extractedText = textDetections[0].description || '';
        }

        // Extract labels
        let labels = [];
        const labelDetections = labelResult.labelAnnotations;
        if (labelDetections.length > 0) {
            labels = labelDetections
                .filter(label => label.score > 0.7)
                .map(label => label.description)
                .slice(0, 3);
        }

        // Extract objects
        let objects = [];
        const objectDetections = objectResult.localizedObjectAnnotations;
        if (objectDetections.length > 0) {
            objects = objectDetections
                .filter(obj => obj.score > 0.7)
                .map(obj => obj.name)
                .slice(0, 3);
        }

        // Generate an initial prompt
        let initialPrompt = `Design a UI based on the uploaded image: ${path.basename(compressedImagePath)}`;
        if (extractedText || labels.length > 0 || objects.length > 0) {
            let elements = [];
            if (extractedText) {
                elements.push(`text: "${extractedText}"`);
            }
            if (labels.length > 0) {
                elements.push(`labels: ${labels.join(', ')}`);
            }
            if (objects.length > 0) {
                elements.push(`objects: ${objects.join(', ')}`);
            }
            initialPrompt = `Design a UI with the following: ${elements.join('; ')} (based on the uploaded image: ${path.basename(compressedImagePath)})`;
        }

        // Check if the prompt is in the cache
        const cacheKey = `prompt:${initialPrompt}`;
        const cachedPrompt = cache.get(cacheKey);
        if (cachedPrompt) {
            console.log('Returning cached prompt:', cachedPrompt);
            return res.json({ prompt: cachedPrompt });
        }

        // Refine the prompt using Gemini API
        let refinedPrompt = initialPrompt;
        let geminiErrorMessage = null;
        try {
            const response = await axios.post(
                `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
                {
                    contents: [
                        {
                            parts: [
                                {
                                    text: `You are a prompt refiner for a UI code generation tool. Given a raw prompt with extracted text, labels, and objects from an image, create a more natural, detailed, and user-friendly prompt for generating UI code. Ensure the refined prompt includes the language/framework (e.g., React, HTML/CSS, Vue) if relevant, and maintains the reference to the uploaded image. Refine this prompt: "${initialPrompt}"`,
                                },
                            ],
                        },
                    ],
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                    }
                }
            );

            if (response.data && response.data.candidates && response.data.candidates[0] && response.data.candidates[0].content) {
                refinedPrompt = response.data.candidates[0].content.parts[0].text.trim();
                // Cache the refined prompt
                cache.set(cacheKey, refinedPrompt);
                console.log('Cached refined prompt:', refinedPrompt);
            } else {
                throw new Error('Invalid response from Gemini API');
            }
        } catch (geminiErr) {
            console.error('Gemini API error:', geminiErr.response ? geminiErr.response.data : geminiErr.message);
            geminiErrorMessage = 'Failed to refine prompt with Gemini API, using initial prompt instead.';
        }

        res.json({ prompt: refinedPrompt, geminiError: geminiErrorMessage });
    } catch (err) {
        console.error('Unexpected error processing image:', err);
        res.status(500).json({ error: 'Unexpected error processing image' });
    }
});

app.get('/', (req, res) => {
    res.render('index');
});

app.get('/register', (req, res) => {
    res.render('register');
});

app.get('/signup', (req, res) => {
    res.render('signup', { error: null });
});

app.post('/signup', async (req, res) => {
    const { firstName, lastName, email, password } = req.body;
    try {
        let user = await User.findOne({ email });
        if (user) {
            return res.render('signup', { error: 'User already exists' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        user = new User({ firstName, lastName, email, password: hashedPassword });
        await user.save();
        req.session.user = user;
        res.redirect('/welcome');
    } catch (err) {
        console.error(err);
        res.render('signup', { error: 'Error during signup' });
    }
});

app.get('/signin', (req, res) => {
    res.render('signin', { error: null });
});

app.post('/signin', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.render('signin', { error: 'User not found' });
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.render('signin', { error: 'Invalid password' });
        }
        req.session.user = user;
        res.redirect('/welcome');
    } catch (err) {
        console.error(err);
        res.render('signin', { error: 'Error during signin' });
    }
});

app.get('/welcome', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/signin');
    }
    res.render('welcome');
});

app.get('/dashboard', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/signin');
    }
    const user = req.session.user;
    try {
        const projects = await Project.find({ userId: user._id }).sort({ createdAt: -1 });
        res.render('dashboard', { user, projects });
    } catch (err) {
        console.error(err);
        res.send('Error loading dashboard');
    }
});

app.get('/project-savee', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/signin');
    }
    const user = req.session.user;
    try {
        const projects = await Project.find({ userId: user._id }).sort({ createdAt: -1 });
        res.render('project-savee', { user, projects });
    } catch (err) {
        console.error(err);
        res.send('Error loading saved projects');
    }
});

app.get('/privacy-policy', (req, res) => {
    res.send('Privacy Policy Page - Under Construction');
});

app.post('/generate-code', async (req, res) => {
    const { prompt, language } = req.body;

    if (!prompt || !language) {
        return res.status(400).json({ error: 'Prompt and language are required' });
    }

    try {
        const response = await axios.post(
            `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
            {
                contents: [
                    {
                        parts: [
                            {
                                text: `You are a frontend code generator. Given a user prompt and a language/framework, generate clean, functional frontend code with proper HTML structure and CSS styling. The code should be ready to use in a ${language} project. If the prompt mentions a "beautiful" design, include modern styling with rounded corners, shadows, and a clean layout. Generate ${language} code for: ${prompt}`,
                            },
                        ],
                    },
                ],
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                }
            }
        );

        // Log the raw response for debugging
        console.log('Gemini API response for code generation:', response.data);

        let generatedCode;
        if (response.data && response.data.candidates && response.data.candidates[0] && response.data.candidates[0].content) {
            generatedCode = response.data.candidates[0].content.parts[0].text.replace(/```[\w]*\n|```/g, '').trim();
        } else {
            throw new Error('Invalid response from Gemini API');
        }

        // Sanitize the generated code to escape backticks and template literals
        generatedCode = generatedCode.replace(/`/g, '\\`').replace(/\${/g, '\\${');

        // Log the generated code for debugging
        console.log('Generated code:', generatedCode);

        let projectId = null;
        const user = req.session.user;
        if (user) {
            const project = new Project({
                userId: user._id,
                prompt,
                language,
                generatedCode,
            });
            await project.save();

            await User.findByIdAndUpdate(user._id, { $push: { projects: project._id } });

            projectId = project._id;
        }

        res.json({ code: generatedCode, projectId });
    } catch (error) {
        console.error('Gemini API error:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to generate code' });
    }
});

app.get('/download/:projectId', async (req, res) => {
    try {
        const project = await Project.findById(req.params.projectId);
        if (!project) {
            return res.status(404).send('Project not found');
        }

        let fileExtension = 'txt';
        if (project.language === 'React') {
            fileExtension = 'jsx';
        } else if (project.language === 'HTML/CSS') {
            fileExtension = 'html';
        } else if (project.language === 'Vue') {
            fileExtension = 'vue';
        }

        res.setHeader('Content-Disposition', `attachment; filename=code.${fileExtension}`);
        res.setHeader('Content-Type', 'text/plain');
        res.send(project.generatedCode);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error downloading project');
    }
});

app.delete('/delete-project/:projectId', async (req, res) => {
    try {
        const projectId = req.params.projectId;
        const user = req.session.user;

        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const project = await Project.findOneAndDelete({ _id: projectId, userId: user._id });
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        await User.findByIdAndUpdate(user._id, { $pull: { projects: projectId } });

        res.json({ message: 'Project deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error deleting project' });
    }
});

app.post('/submit-feedback/:projectId', async (req, res) => {
    try {
        const { projectId } = req.params;
        const { rating, comments } = req.body;
        const user = req.session.user;

        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating must be between 1 and 5' });
        }

        const project = await Project.findOneAndUpdate(
            { _id: projectId, userId: user._id },
            { rating, comments },
            { new: true }
        );

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json({ message: 'Feedback submitted successfully' });
    } catch (err) {
        console.error('Error submitting feedback:', err);
        res.status(500).json({ error: 'Error submitting feedback' });
    }
});

app.get('/preview/:projectId', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/signin');
    }
    try {
        const project = await Project.findById(req.params.projectId);
        if (!project || project.userId.toString() !== req.session.user._id.toString()) {
            return res.status(404).send('Project not found');
        }
        res.render('preview', { project });
    } catch (error) {
        res.status(500).send('Error loading preview');
    }
});

app.get('/share/:projectId', async (req, res) => {
    try {
        const project = await Project.findById(req.params.projectId);
        if (!project) {
            return res.status(404).send('Project not found');
        }
        res.render('share', { project });
    } catch (error) {
        res.status(500).send('Error loading shared project');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.send('Error logging out');
        }
        res.redirect('/signin');
    });
});

// Schedule cleanup of old images
cron.schedule('0 0 * * *', async () => { // Runs every day at midnight
    console.log('Running cleanup of old images...');
    try {
        const files = await fs.promises.readdir('uploads');
        const now = Date.now();
        const oneDayInMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

        for (const file of files) {
            const filePath = path.join('uploads', file);
            const stats = await fs.promises.stat(filePath);
            if (now - stats.mtimeMs > oneDayInMs) {
                await fs.promises.unlink(filePath);
                console.log(`Deleted old image: ${file}`);
            }
        }
    } catch (err) {
        console.error('Error during image cleanup:', err);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});