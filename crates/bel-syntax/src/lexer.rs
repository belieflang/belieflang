use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenKind {
    Identifier(String),
    Number(String),
    StringLit(String),
    LBrace,
    RBrace,
    LParen,
    RParen,
    Colon,
    Dot,
    Eq,
    Gt,
    Gte,
    Lt,
    Lte,
    EqEq,
    Neq,
    And,
    Or,
    Not,
    Newline,
    Eof,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub line: usize,
    pub col: usize,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("{message} at {line}:{col}")]
pub struct SyntaxError {
    pub message: String,
    pub line: usize,
    pub col: usize,
}

pub fn strip_comments(source: &str) -> String {
    source
        .lines()
        .map(|line| line.split_once('#').map(|(l, _)| l).unwrap_or(line))
        .collect::<Vec<&str>>()
        .join("\n")
}

pub fn tokenize(source: &str) -> Result<Vec<Token>, SyntaxError> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = source.chars().collect();
    let len = chars.len();
    let mut i = 0;
    let mut line = 1;
    let mut col = 1;

    while i < len {
        let ch = chars[i];

        if ch == ' ' || ch == '\t' || ch == '\r' {
            i += 1;
            col += 1;
            continue;
        }

        if ch == '\n' {
            tokens.push(Token {
                kind: TokenKind::Newline,
                line,
                col,
            });
            i += 1;
            line += 1;
            col = 1;
            continue;
        }

        if ch == '#' {
            while i < len && chars[i] != '\n' {
                i += 1;
                col += 1;
            }
            continue;
        }

        if ch == '"' {
            let token_line = line;
            let token_col = col;
            i += 1;
            col += 1;

            let mut value = String::new();
            let mut closed = false;

            while i < len {
                let next_char = chars[i];

                if next_char == '"' {
                    i += 1;
                    col += 1;
                    closed = true;
                    break;
                }

                if next_char == '\\' {
                    if i + 1 >= len {
                        return Err(SyntaxError {
                            message: "Unterminated string literal".to_string(),
                            line: token_line,
                            col: token_col,
                        });
                    }
                    let escaped = chars[i + 1];
                    match escaped {
                        'n' => value.push('\n'),
                        't' => value.push('\t'),
                        '"' => value.push('"'),
                        '\\' => value.push('\\'),
                        other => value.push(other),
                    }
                    i += 2;
                    col += 2;
                    continue;
                }

                if next_char == '\n' {
                    return Err(SyntaxError {
                        message: "Unterminated string literal".to_string(),
                        line: token_line,
                        col: token_col,
                    });
                }

                value.push(next_char);
                i += 1;
                col += 1;
            }

            if !closed {
                return Err(SyntaxError {
                    message: "Unterminated string literal".to_string(),
                    line: token_line,
                    col: token_col,
                });
            }

            tokens.push(Token {
                kind: TokenKind::StringLit(value),
                line: token_line,
                col: token_col,
            });
            continue;
        }

        if ch.is_ascii_digit() {
            let token_line = line;
            let token_col = col;
            let start = i;

            while i < len && chars[i].is_ascii_digit() {
                i += 1;
                col += 1;
            }

            if i < len && chars[i] == '.' {
                i += 1;
                col += 1;

                while i < len && chars[i].is_ascii_digit() {
                    i += 1;
                    col += 1;
                }
            }

            let raw: String = chars[start..i].iter().collect();
            if raw.ends_with('.') {
                return Err(SyntaxError {
                    message: format!("Invalid number '{raw}'"),
                    line: token_line,
                    col: token_col,
                });
            }

            tokens.push(Token {
                kind: TokenKind::Number(raw),
                line: token_line,
                col: token_col,
            });
            continue;
        }

        if ch.is_ascii_alphabetic() || ch == '_' {
            let token_line = line;
            let token_col = col;
            let start = i;

            i += 1;
            col += 1;

            while i < len && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
                col += 1;
            }

            let raw: String = chars[start..i].iter().collect();
            tokens.push(Token {
                kind: TokenKind::Identifier(raw),
                line: token_line,
                col: token_col,
            });
            continue;
        }

        if i + 1 < len {
            let two_char: String = chars[i..i + 2].iter().collect();
            let kind = match two_char.as_str() {
                ">=" => Some(TokenKind::Gte),
                "<=" => Some(TokenKind::Lte),
                "==" => Some(TokenKind::EqEq),
                "!=" => Some(TokenKind::Neq),
                "&&" => Some(TokenKind::And),
                "||" => Some(TokenKind::Or),
                _ => None,
            };

            if let Some(kind) = kind {
                tokens.push(Token { kind, line, col });
                i += 2;
                col += 2;
                continue;
            }
        }

        let kind = match ch {
            '{' => Some(TokenKind::LBrace),
            '}' => Some(TokenKind::RBrace),
            '(' => Some(TokenKind::LParen),
            ')' => Some(TokenKind::RParen),
            ':' => Some(TokenKind::Colon),
            '.' => Some(TokenKind::Dot),
            '=' => Some(TokenKind::Eq),
            '>' => Some(TokenKind::Gt),
            '<' => Some(TokenKind::Lt),
            '!' => Some(TokenKind::Not),
            _ => None,
        };

        if let Some(kind) = kind {
            tokens.push(Token { kind, line, col });
            i += 1;
            col += 1;
            continue;
        }

        return Err(SyntaxError {
            message: format!("Unexpected character '{ch}'"),
            line,
            col,
        });
    }

    tokens.push(Token {
        kind: TokenKind::Eof,
        line,
        col,
    });
    Ok(tokens)
}
