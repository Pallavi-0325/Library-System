// server.js - Express backend with Google Books API and Open Library fallback
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize cache with 1 hour TTL
const cache = new NodeCache({ stdTTL: 3600 });

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting - 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.'
  }
});

app.use('/api/', limiter);

// Debug middleware to log requests
app.use('/api/', (req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`, req.query);
  next();
});

// Google Books API configuration
const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY;
const GOOGLE_BOOKS_BASE_URL = 'https://www.googleapis.com/books/v1/volumes';

// Library storage (in-memory)
let libraryBooks = [];
let borrowedBooks = [];

// Utility functions
function extractISBN(identifiers) {
  if (!identifiers) return null;
  
  const isbn13 = identifiers.find(id => id.type === 'ISBN_13');
  const isbn10 = identifiers.find(id => id.type === 'ISBN_10');
  
  return isbn13?.identifier || isbn10?.identifier || null;
}

function formatGoogleBooksResponse(items) {
  return items.map(item => ({
    id: item.id,
    title: item.volumeInfo?.title || 'Unknown Title',
    authors: item.volumeInfo?.authors || ['Unknown Author'],
    publishedDate: item.volumeInfo?.publishedDate || null,
    description: item.volumeInfo?.description || null,
    thumbnail: item.volumeInfo?.imageLinks?.thumbnail || null,
    categories: item.volumeInfo?.categories || [],
    pageCount: item.volumeInfo?.pageCount || null,
    language: item.volumeInfo?.language || null,
    isbn: extractISBN(item.volumeInfo?.industryIdentifiers),
    publisher: item.volumeInfo?.publisher || null,
    source: 'google'
  }));
}

function formatOpenLibraryResponse(docs) {
  return docs.map(doc => ({
    id: doc.key?.replace('/works/', '') || doc.cover_edition_key,
    title: doc.title || 'Unknown Title',
    authors: doc.author_name || ['Unknown Author'],
    publishedDate: doc.first_publish_year?.toString() || null,
    description: null, // Open Library search doesn't include descriptions
    thumbnail: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
    categories: doc.subject?.slice(0, 5) || [], // Limit to first 5 subjects
    pageCount: null,
    language: doc.language?.[0] || null,
    isbn: doc.isbn?.[0] || null,
    publisher: doc.publisher?.[0] || null,
    source: 'openlibrary'
  }));
}

function formatGoogleBookDetails(volumeInfo) {
  return {
    id: volumeInfo.id,
    title: volumeInfo.volumeInfo?.title || 'Unknown Title',
    authors: volumeInfo.volumeInfo?.authors || ['Unknown Author'],
    publishedDate: volumeInfo.volumeInfo?.publishedDate || null,
    description: volumeInfo.volumeInfo?.description || null,
    thumbnail: volumeInfo.volumeInfo?.imageLinks?.thumbnail || null,
    smallThumbnail: volumeInfo.volumeInfo?.imageLinks?.smallThumbnail || null,
    categories: volumeInfo.volumeInfo?.categories || [],
    pageCount: volumeInfo.volumeInfo?.pageCount || null,
    language: volumeInfo.volumeInfo?.language || null,
    isbn: extractISBN(volumeInfo.volumeInfo?.industryIdentifiers),
    publisher: volumeInfo.volumeInfo?.publisher || null,
    previewLink: volumeInfo.volumeInfo?.previewLink || null,
    infoLink: volumeInfo.volumeInfo?.infoLink || null,
    source: 'google'
  };
}

function formatOpenLibraryBookDetails(workInfo) {
  return {
    id: workInfo.key?.replace('/works/', ''),
    title: workInfo.title || 'Unknown Title',
    authors: workInfo.authors?.map(author => author.name) || ['Unknown Author'],
    publishedDate: workInfo.first_publish_date || null,
    description: workInfo.description?.value || workInfo.description || null,
    thumbnail: workInfo.covers?.[0] ? `https://covers.openlibrary.org/b/id/${workInfo.covers[0]}-M.jpg` : null,
    categories: workInfo.subjects?.slice(0, 5) || [],
    pageCount: null,
    language: null,
    isbn: null,
    publisher: null,
    source: 'openlibrary'
  };
}

// Main search endpoint (consolidated)
app.get('/api/search', async (req, res) => {
  try {
    const { q, page = 0 } = req.query;
    
    if (!q || q.trim() === '') {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    // Parse page number and handle invalid values
    let pageNum = parseInt(page);
    if (isNaN(pageNum) || pageNum < 0) {
      pageNum = 0;
    }
    
    const startIndex = pageNum * 10;
    
    // Create cache key
    const cacheKey = `search_${q}_${startIndex}_10`;
    
    // Check cache first
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json({
        books: cachedResult.books,
        totalPages: Math.ceil((cachedResult.totalItems || 0) / 10),
        currentPage: parseInt(page),
        fromCache: true
      });
    }

    let books = [];
    let totalItems = 0;
    let source = 'google';

    try {
      // Try Google Books API first
      if (GOOGLE_BOOKS_API_KEY) {
        const googleResponse = await axios.get(GOOGLE_BOOKS_BASE_URL, {
          params: {
            q,
            startIndex,
            maxResults: 10,
            key: GOOGLE_BOOKS_API_KEY
          },
          timeout: 5000
        });

        books = formatGoogleBooksResponse(googleResponse.data.items || []);
        totalItems = googleResponse.data.totalItems || 0;
      } else {
        throw new Error('No Google Books API key available');
      }
    } catch (error) {
      console.log('Google Books API failed, falling back to Open Library:', error.message);
      
      // Fallback to Open Library API
      try {
        const openLibResponse = await axios.get('https://openlibrary.org/search.json', {
          params: {
            q,
            offset: startIndex,
            limit: 10
          },
          timeout: 5000
        });

        books = formatOpenLibraryResponse(openLibResponse.data.docs || []);
        totalItems = openLibResponse.data.numFound || 0;
        source = 'openlibrary';
      } catch (fallbackError) {
        console.error('Both APIs failed:', fallbackError.message);
        return res.status(503).json({
          error: 'Book search service temporarily unavailable'
        });
      }
    }

    const result = {
      books,
      totalItems,
      source,
      query: q.trim(),
      startIndex: startIndex,
      maxResults: 10
    };

    // Cache the result
    cache.set(cacheKey, result);

    // Return in format expected by frontend
    res.json({
      books: result.books,
      totalPages: Math.ceil((result.totalItems || 0) / 10),
      currentPage: pageNum,
      totalItems: result.totalItems,
      source: result.source
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Alternative book search endpoint (for compatibility)
app.get('/api/books/search', async (req, res) => {
  try {
    const { q, startIndex = 0, maxResults = 10 } = req.query;
    
    if (!q) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    // Create cache key
    const cacheKey = `search_${q}_${startIndex}_${maxResults}`;
    
    // Check cache first
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json({
        ...cachedResult,
        fromCache: true
      });
    }

    let books = [];
    let totalItems = 0;
    let source = 'google';

    try {
      // Try Google Books API first
      if (GOOGLE_BOOKS_API_KEY) {
        const googleResponse = await axios.get(GOOGLE_BOOKS_BASE_URL, {
          params: {
            q,
            startIndex,
            maxResults,
            key: GOOGLE_BOOKS_API_KEY
          },
          timeout: 5000
        });

        books = formatGoogleBooksResponse(googleResponse.data.items || []);
        totalItems = googleResponse.data.totalItems || 0;
      } else {
        throw new Error('No Google Books API key available');
      }
    } catch (error) {
      console.log('Google Books API failed, falling back to Open Library:', error.message);
      
      // Fallback to Open Library API
      try {
        const openLibResponse = await axios.get('https://openlibrary.org/search.json', {
          params: {
            q,
            offset: startIndex,
            limit: maxResults
          },
          timeout: 5000
        });

        books = formatOpenLibraryResponse(openLibResponse.data.docs || []);
        totalItems = openLibResponse.data.numFound || 0;
        source = 'openlibrary';
      } catch (fallbackError) {
        console.error('Both APIs failed:', fallbackError.message);
        return res.status(503).json({
          error: 'Book search service temporarily unavailable'
        });
      }
    }

    const result = {
      books,
      totalItems,
      source,
      query: q,
      startIndex: parseInt(startIndex),
      maxResults: parseInt(maxResults)
    };

    // Cache the result
    cache.set(cacheKey, result);

    res.json(result);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get book details by ID
app.get('/api/books/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `book_${id}`;
    
    // Check cache first
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return res.json({
        ...cachedResult,
        fromCache: true
      });
    }

    let book = null;
    let source = 'google';

    try {
      // Try Google Books API first
      if (GOOGLE_BOOKS_API_KEY) {
        const googleResponse = await axios.get(`${GOOGLE_BOOKS_BASE_URL}/${id}`, {
          params: {
            key: GOOGLE_BOOKS_API_KEY
          },
          timeout: 5000
        });

        book = formatGoogleBookDetails(googleResponse.data);
      } else {
        throw new Error('No Google Books API key available');
      }
    } catch (error) {
      console.log('Google Books API failed for book details, trying Open Library');
      
      // For Open Library, we need to search by the ID format
      try {
        const openLibResponse = await axios.get(`https://openlibrary.org/works/${id}.json`, {
          timeout: 5000
        });

        book = formatOpenLibraryBookDetails(openLibResponse.data);
        source = 'openlibrary';
      } catch (fallbackError) {
        return res.status(404).json({
          error: 'Book not found'
        });
      }
    }

    const result = {
      book,
      source
    };

    // Cache the result
    cache.set(cacheKey, result);

    res.json(result);
  } catch (error) {
    console.error('Book details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get library books
app.get('/api/library', (req, res) => {
  res.json(libraryBooks);
});

// Add book to library
app.post('/api/library', async (req, res) => {
  try {
    const { bookId } = req.body;
    
    if (!bookId) {
      return res.status(400).json({ error: 'Book ID is required' });
    }
    
    // Check if book already exists
    if (libraryBooks.some(book => book.id === bookId)) {
      return res.status(400).json({ error: 'Book already exists in library' });
    }
    
    let bookData = null;
    
    try {
      // Try Google Books API first
      if (GOOGLE_BOOKS_API_KEY) {
        const response = await axios.get(`${GOOGLE_BOOKS_BASE_URL}/${bookId}`, {
          params: { key: GOOGLE_BOOKS_API_KEY },
          timeout: 5000
        });
        
        bookData = formatGoogleBookDetails(response.data);
      } else {
        throw new Error('No Google Books API key available');
      }
    } catch (error) {
      // Fallback to Open Library
      try {
        const response = await axios.get(`https://openlibrary.org/works/${bookId}.json`, {
          timeout: 5000
        });
        
        bookData = formatOpenLibraryBookDetails(response.data);
      } catch (fallbackError) {
        return res.status(404).json({ error: 'Book not found' });
      }
    }
    
    libraryBooks.push(bookData);
    res.json(bookData);
  } catch (error) {
    console.error('Add to library error:', error);
    res.status(500).json({ error: 'Failed to add book to library' });
  }
});

// Remove book from library
app.delete('/api/library/:id', (req, res) => {
  const { id } = req.params;
  
  const initialLength = libraryBooks.length;
  libraryBooks = libraryBooks.filter(book => book.id !== id);
  
  if (libraryBooks.length === initialLength) {
    return res.status(404).json({ error: 'Book not found in library' });
  }
  
  // Also remove from borrowed books if present
  borrowedBooks = borrowedBooks.filter(book => book.bookId !== id);
  res.json({ message: 'Book removed successfully' });
});

// Get borrowed books
app.get('/api/borrowed', (req, res) => {
  res.json(borrowedBooks);
});

// Borrow a book
app.post('/api/borrow', (req, res) => {
  const { bookId } = req.body;
  
  if (!bookId) {
    return res.status(400).json({ error: 'Book ID is required' });
  }
  
  // Check if book exists in library
  if (!libraryBooks.some(book => book.id === bookId)) {
    return res.status(404).json({ error: 'Book not found in library' });
  }
  
  // Check if book is already borrowed
  if (borrowedBooks.some(book => book.bookId === bookId)) {
    return res.status(400).json({ error: 'Book is already borrowed' });
  }
  
  // Add to borrowed books with due date (14 days from now)
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 14);
  
  const borrowRecord = {
    bookId,
    borrowDate: new Date(),
    dueDate
  };
  
  borrowedBooks.push(borrowRecord);
  res.json(borrowRecord);
});

// Return a book
app.post('/api/return/:id', (req, res) => {
  const { id } = req.params;
  
  const initialLength = borrowedBooks.length;
  borrowedBooks = borrowedBooks.filter(book => book.bookId !== id);
  
  if (borrowedBooks.length === initialLength) {
    return res.status(404).json({ error: 'Book not found in borrowed list' });
  }
  
  res.json({ message: 'Book returned successfully' });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    googleBooksAvailable: !!GOOGLE_BOOKS_API_KEY,
    cacheStats: cache.getStats(),
    libraryCount: libraryBooks.length,
    borrowedCount: borrowedBooks.length
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Library Management API server running on port ${PORT}`);
  console.log(`Google Books API: ${GOOGLE_BOOKS_API_KEY ? 'Enabled' : 'Disabled (will use Open Library)'}`);
});

module.exports = app;
