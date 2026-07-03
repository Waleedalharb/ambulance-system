const fs = require('fs');

// Create a multi-size ICO file from PNGs
// ICO format: Header (6 bytes) + Directory (16 bytes * count) + Image data

function createIco(pngFiles, sizes, outputPath) {
    const buffers = pngFiles.map(f => fs.readFileSync(f));
    const count = buffers.length;
    
    // ICO Header: Reserved(2) + Type(2) + Count(2)
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);  // Reserved
    header.writeUInt16LE(1, 2);  // Type: 1 = icon
    header.writeUInt16LE(count, 4); // Count
    
    // Calculate offsets
    const headerSize = 6;
    const dirSize = 16 * count;
    let dataOffset = headerSize + dirSize;
    
    const dirEntries = [];
    const imageData = [];
    
    for (let i = 0; i < count; i++) {
        const buf = buffers[i];
        const size = buf.length;
        const width = sizes[i];
        const height = sizes[i]; // Square icons
        
        // ICO Directory Entry: Width, Height, Colors, Reserved, Planes, BitDepth, Size, Offset
        const entry = Buffer.alloc(16);
        entry.writeUInt8(width === 256 ? 0 : width, 0);  // Width (0 means 256)
        entry.writeUInt8(height === 256 ? 0 : height, 1);  // Height (0 means 256)
        entry.writeUInt8(0, 2);      // Colors (0 = >256)
        entry.writeUInt8(0, 3);      // Reserved
        entry.writeUInt16LE(1, 4);   // Color planes
        entry.writeUInt16LE(32, 6);  // Bits per pixel
        entry.writeUInt32LE(size, 8); // Image size in bytes
        entry.writeUInt32LE(dataOffset, 12); // Offset to image data
        
        dirEntries.push(entry);
        imageData.push(buf);
        dataOffset += size;
    }
    
    // Combine all parts
    const parts = [header, ...dirEntries, ...imageData];
    const icoBuffer = Buffer.concat(parts);
    
    fs.writeFileSync(outputPath, icoBuffer);
    console.log(`Created ${outputPath}: ${icoBuffer.length} bytes (${count} images: ${sizes.join(', ')}px)`);
}

const pngFiles = [
    'public/favicon-16x16.png',
    'public/favicon-32x32.png',
    'public/favicon-48x48.png'
];
const sizes = [16, 32, 48];

createIco(pngFiles, sizes, 'public/favicon.ico');
