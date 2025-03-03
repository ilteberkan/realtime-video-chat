const fs = require('fs');
const path = require('path');
const UglifyJS = require('uglify-js');

// Minify ve obfuscate edilecek klasör
const publicDir = path.join(__dirname, '../public');

// JavaScript dosyalarını bul
function findJsFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      findJsFiles(filePath, fileList);
    } else if (path.extname(file) === '.js') {
      fileList.push(filePath);
    }
  });
  
  return fileList;
}

// JavaScript dosyalarını minify et
function minifyJsFiles() {
  const jsFiles = findJsFiles(publicDir);
  
  jsFiles.forEach(file => {
    console.log(`Minifying: ${file}`);
    
    const content = fs.readFileSync(file, 'utf8');
    const minified = UglifyJS.minify(content, {
      compress: {
        drop_console: true,
        drop_debugger: true
      },
      mangle: true
    });
    
    if (minified.error) {
      console.error(`Error minifying ${file}:`, minified.error);
    } else {
      // Minify edilmiş dosyayı kaydet
      fs.writeFileSync(file, minified.code, 'utf8');
      console.log(`Minified: ${file}`);
    }
  });
}

// HTML dosyalarındaki inline JavaScript'i minify et
function minifyHtmlFiles() {
  const htmlFiles = fs.readdirSync(publicDir).filter(file => path.extname(file) === '.html');
  
  htmlFiles.forEach(file => {
    const filePath = path.join(publicDir, file);
    console.log(`Processing HTML: ${filePath}`);
    
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Script tagları içindeki JavaScript'i bul ve minify et
    content = content.replace(/<script>([\s\S]*?)<\/script>/g, (match, p1) => {
      const minified = UglifyJS.minify(p1, {
        compress: {
          drop_console: true,
          drop_debugger: true
        },
        mangle: true
      });
      
      if (minified.error) {
        console.error(`Error minifying script in ${file}:`, minified.error);
        return match;
      }
      
      return `<script>${minified.code}</script>`;
    });
    
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Processed HTML: ${filePath}`);
  });
}

// Build işlemini başlat
console.log('Building application...');
minifyJsFiles();
minifyHtmlFiles();
console.log('Build completed!'); 