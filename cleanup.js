const fs = require('fs').promises;
const path = require('path');

const uploadsDir = path.join(__dirname, 'uploads');

async function cleanupOldImages() {
    try {
        const files = await fs.readdir(uploadsDir);
        const now = Date.now();
        const oneDayInMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

        for (const file of files) {
            const filePath = path.join(uploadsDir, file);
            const stats = await fs.stat(filePath);
            const fileAge = now - stats.mtimeMs;

            if (fileAge > oneDayInMs) {
                await fs.unlink(filePath);
                console.log(`Deleted old image: ${file}`);
            }
        }
        console.log('Image cleanup completed.');
    } catch (err) {
        console.error('Error during image cleanup:', err);
    }
}

cleanupOldImages();